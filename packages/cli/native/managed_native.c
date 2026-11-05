/* Small, synchronous OS primitives. Policy and durable authorization live in TypeScript. */
#include <node_api.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#ifdef _WIN32
#include <windows.h>
#include <winternl.h>
#else
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <dirent.h>
#endif
#ifdef __APPLE__
#include <libproc.h>
#include <sys/proc.h>
#endif

#define MAX_BYTES (64 * 1024 * 1024)
#define MAX_ENTRIES 100000
#define MAGIC 0x52434c49

typedef struct {
  uint32_t magic;
  int kind; /* 1 filesystem, 2 job */
#ifdef _WIN32
  HANDLE value;
#else
  int value;
#endif
  int closed;
} resource;

typedef struct { uint64_t dev, ino, size, mtime, links, uid; int directory, regular; } metadata;

static napi_value fail(napi_env env, const char *message, const char *code) {
  napi_value text, error, c;
  napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &text);
  napi_create_error(env, NULL, text, &error);
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &c);
  napi_set_named_property(env, error, "code", c);
  napi_throw(env, error);
  return NULL;
}
static napi_value osfail(napi_env env, const char *message) {
#ifdef _WIN32
  DWORD e = GetLastError();
  const char *code = (e == ERROR_FILE_NOT_FOUND || e == ERROR_PATH_NOT_FOUND) ? "ENOENT" : e == ERROR_ACCESS_DENIED ? "EACCES" : "EIO";
#else
  const char *code = errno == ENOENT ? "ENOENT" : errno == EACCES ? "EACCES" : errno == ESRCH ? "ESRCH" : "EIO";
#endif
  return fail(env, message, code);
}
static napi_value nothing(napi_env env) { napi_value result; napi_get_undefined(env, &result); return result; }
static void close_resource(resource *r) {
  if (r && !r->closed) {
    r->closed = 1;
#ifdef _WIN32
    CloseHandle(r->value);
#else
    close(r->value);
#endif
  }
}
static void finalize(napi_env env, void *data, void *hint) { (void)env; (void)hint; resource *r = data; close_resource(r); free(r); }
static resource *get_resource(napi_env env, napi_value value, int kind) {
  resource *r = NULL;
  if (napi_get_value_external(env, value, (void **)&r) != napi_ok || !r || r->magic != MAGIC || r->kind != kind || r->closed) {
    fail(env, "Native resource is unavailable", "EINVAL"); return NULL;
  }
  return r;
}
static napi_value wrap(napi_env env, resource *r) {
  napi_value result; r->magic = MAGIC;
  if (napi_create_external(env, r, finalize, NULL, &result) != napi_ok) { close_resource(r); free(r); return fail(env, "Cannot retain native resource", "ENOMEM"); }
  return result;
}
static char *string_arg(napi_env env, napi_value value) {
  size_t size = 0, got = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &size) != napi_ok || size > 32768) { fail(env, "Invalid native string", "EINVAL"); return NULL; }
  char *s = calloc(size + 1, 1);
  if (!s) { fail(env, "Native allocation failed", "ENOMEM"); return NULL; }
  napi_get_value_string_utf8(env, value, s, size + 1, &got);
  if (got != size || strlen(s) != size) { free(s); fail(env, "Invalid native string", "EINVAL"); return NULL; }
  return s;
}
static int component(const char *s) { return *s && strcmp(s, ".") && strcmp(s, "..") && !strchr(s, '/') && !strchr(s, '\\') && !strchr(s, ':'); }
static int args(napi_env env, napi_callback_info info, size_t count, napi_value *values) {
  size_t n = count;
  if (napi_get_cb_info(env, info, &n, values, NULL, NULL) != napi_ok || n != count) { fail(env, "Invalid native arguments", "EINVAL"); return 0; } return 1;
}
static void number_string(napi_env env, napi_value object, const char *key, uint64_t number) {
  char text[32]; snprintf(text, sizeof(text), "%llu", (unsigned long long)number);
  napi_value value; napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, object, key, value);
}
#ifdef _WIN32
static wchar_t *wide(const char *text) {
  int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, -1, NULL, 0);
  if (!n) return NULL;
  wchar_t *result = calloc((size_t)n, sizeof(wchar_t));
  if (result) MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, -1, result, n);
  return result;
}
static HANDLE relative_open(HANDLE parent, const char *name, int directory, int writable) {
  typedef NTSTATUS (NTAPI *create_fn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
  typedef ULONG (WINAPI *error_fn)(NTSTATUS);
  HMODULE library = GetModuleHandleW(L"ntdll.dll");
  create_fn create = (create_fn)(void *)GetProcAddress(library, "NtCreateFile");
  error_fn error = (error_fn)(void *)GetProcAddress(library, "RtlNtStatusToDosError");
  if (!create || !error) { SetLastError(ERROR_NOT_SUPPORTED); return INVALID_HANDLE_VALUE; }
  wchar_t *text = wide(name); if (!text) { SetLastError(ERROR_INVALID_NAME); return INVALID_HANDLE_VALUE; }
  UNICODE_STRING filename; filename.Buffer = text; filename.Length = (USHORT)(wcslen(text) * sizeof(wchar_t)); filename.MaximumLength = filename.Length;
  OBJECT_ATTRIBUTES attributes; memset(&attributes, 0, sizeof(attributes)); attributes.Length = sizeof(attributes);
  attributes.RootDirectory = parent; attributes.ObjectName = &filename; attributes.Attributes = 0x40 | 0x1000; /* CASE_INSENSITIVE | DONT_REPARSE */
  IO_STATUS_BLOCK status; HANDLE handle = INVALID_HANDLE_VALUE;
  ACCESS_MASK access = FILE_READ_ATTRIBUTES | SYNCHRONIZE | (directory == 1 ? FILE_LIST_DIRECTORY : FILE_READ_DATA) | (writable ? DELETE : 0);
  NTSTATUS code = create(&handle, access, &attributes, &status, NULL, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    1 /* FILE_OPEN */, 0x00200000 /* OPEN_REPARSE_POINT */ | 0x20 /* SYNCHRONOUS_IO_NONALERT */ | (directory == 1 ? 1 : 0), NULL, 0);
  free(text);
  if (code < 0) { SetLastError(error(code)); return INVALID_HANDLE_VALUE; }
  return handle;
}
#endif
static int stat_resource(resource *r, metadata *m) {
#ifdef _WIN32
  BY_HANDLE_FILE_INFORMATION s;
  if (!GetFileInformationByHandle(r->value, &s)) return 0;
  m->dev = s.dwVolumeSerialNumber; m->ino = ((uint64_t)s.nFileIndexHigh << 32) | s.nFileIndexLow;
  m->size = ((uint64_t)s.nFileSizeHigh << 32) | s.nFileSizeLow;
  uint64_t ft = ((uint64_t)s.ftLastWriteTime.dwHighDateTime << 32) | s.ftLastWriteTime.dwLowDateTime;
  m->mtime = (ft - UINT64_C(116444736000000000)) * 100;
  m->links = s.nNumberOfLinks; m->uid = 0;
  m->directory = !!(s.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY);
  m->regular = !m->directory && GetFileType(r->value) == FILE_TYPE_DISK;
  if (s.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) { SetLastError(ERROR_CANT_ACCESS_FILE); return 0; }
#else
  struct stat s; if (fstat(r->value, &s)) return 0;
  m->dev = s.st_dev; m->ino = s.st_ino; m->size = s.st_size; m->links = s.st_nlink; m->uid = s.st_uid;
#ifdef __APPLE__
  m->mtime = (uint64_t)s.st_mtimespec.tv_sec * 1000000000 + s.st_mtimespec.tv_nsec;
#else
  m->mtime = (uint64_t)s.st_mtim.tv_sec * 1000000000 + s.st_mtim.tv_nsec;
#endif
  m->directory = S_ISDIR(s.st_mode); m->regular = S_ISREG(s.st_mode);
#endif
  return 1;
}
static napi_value stat_value(napi_env env, metadata *s) {
  napi_value result, kind; napi_create_object(env, &result);
  number_string(env,result,"dev",s->dev); number_string(env,result,"ino",s->ino); number_string(env,result,"size",s->size);
  number_string(env,result,"mtime",s->mtime); number_string(env,result,"nlink",s->links); number_string(env,result,"uid",s->uid);
  napi_create_string_utf8(env, s->directory ? "directory" : s->regular ? "file" : "other", NAPI_AUTO_LENGTH, &kind);
  napi_set_named_property(env,result,"kind",kind); return result;
}
static napi_value open_root(napi_env env, napi_callback_info info) {
  napi_value a[1]; if (!args(env,info,1,a)) return NULL; char *name = string_arg(env,a[0]); if (!name) return NULL;
  resource *r = calloc(1,sizeof(*r)); if (!r) { free(name); return fail(env,"Native allocation failed","ENOMEM"); } r->kind=1;
#ifdef _WIN32
  wchar_t *text=wide(name); r->value = text ? CreateFileW(text, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    NULL,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,NULL) : INVALID_HANDLE_VALUE; free(text);
  int valid = r->value != INVALID_HANDLE_VALUE;
#else
  r->value = open(name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC); int valid = r->value >= 0;
#endif
  free(name); if (!valid) { free(r); return osfail(env,"Cannot open native directory"); }
  metadata s; if (!stat_resource(r,&s) || !s.directory) { close_resource(r); free(r); return fail(env,"Unsafe native directory","EINVAL"); }
  return wrap(env,r);
}
static resource *open_child_resource(napi_env env, resource *parent, const char *name, int directory, int writable) {
  if (!component(name)) { fail(env,"Invalid native path component","EINVAL"); return NULL; }
  resource *r = calloc(1,sizeof(*r)); if (!r) { fail(env,"Native allocation failed","ENOMEM"); return NULL; } r->kind=1;
#ifdef _WIN32
  r->value=relative_open(parent->value,name,directory,writable); int valid=r->value!=INVALID_HANDLE_VALUE;
#else
  (void)writable;
  r->value=openat(parent->value,name,O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK|(directory==1?O_DIRECTORY:0)); int valid=r->value>=0;
#endif
  if (!valid) { free(r); osfail(env,"Cannot open native child"); return NULL; }
  metadata s; if (!stat_resource(r,&s) || (directory == 1 ? !s.directory : directory == 0 ? !s.regular : (!s.regular && !s.directory))) { close_resource(r); free(r); fail(env,"Unsupported native child","EINVAL"); return NULL; }
  return r;
}
static napi_value open_child(napi_env env,napi_callback_info info) {
  napi_value a[3]; if(!args(env,info,3,a))return NULL; resource *p=get_resource(env,a[0],1); if(!p)return NULL;
  char *name=string_arg(env,a[1]); if(!name)return NULL; bool directory;
  if(napi_get_value_bool(env,a[2],&directory)!=napi_ok){free(name);return fail(env,"Invalid entry kind","EINVAL");}
  resource *r=open_child_resource(env,p,name,directory,0);free(name);return r?wrap(env,r):NULL;
}
static napi_value open_entry(napi_env env,napi_callback_info info) {
  napi_value a[2];if(!args(env,info,2,a))return NULL;resource *p=get_resource(env,a[0],1);if(!p)return NULL;
  char *name=string_arg(env,a[1]);if(!name)return NULL;resource *r=open_child_resource(env,p,name,-1,0);free(name);return r?wrap(env,r):NULL;
}
static napi_value stat_handle(napi_env env,napi_callback_info info) {
  napi_value a[1];if(!args(env,info,1,a))return NULL;resource *r=get_resource(env,a[0],1);if(!r)return NULL;
  metadata s;if(!stat_resource(r,&s))return osfail(env,"Cannot inspect native resource");return stat_value(env,&s);
}
static int equal_field(napi_env env,napi_value expected,const char *field,uint64_t number) {
  napi_value value;if(napi_get_named_property(env,expected,field,&value)!=napi_ok)return 0;
  char *text=string_arg(env,value);if(!text)return 0;char actual[32];snprintf(actual,sizeof(actual),"%llu",(unsigned long long)number);
  int equal=!strcmp(text,actual);free(text);return equal;
}
static napi_value remove_child(napi_env env,napi_callback_info info) {
  napi_value a[4];if(!args(env,info,4,a))return NULL;resource *p=get_resource(env,a[0],1);if(!p)return NULL;
  char *name=string_arg(env,a[1]);if(!name)return NULL;bool directory;
  if(napi_get_value_bool(env,a[2],&directory)!=napi_ok){free(name);return fail(env,"Invalid entry kind","EINVAL");}
  resource *r=open_child_resource(env,p,name,directory,1);if(!r){free(name);return NULL;}
  metadata s;int valid=stat_resource(r,&s)&&equal_field(env,a[3],"dev",s.dev)&&equal_field(env,a[3],"ino",s.ino)
    &&(directory||(s.links==1&&equal_field(env,a[3],"size",s.size)&&equal_field(env,a[3],"mtime",s.mtime)));
#ifndef _WIN32
  valid=valid&&s.uid==(uint64_t)getuid();
#endif
  if(!valid){close_resource(r);free(r);free(name);return fail(env,"Prepared native entry changed","ESTALE");}
#ifdef _WIN32
  struct { DWORD Flags; } disposition = { 1 | 2 }; /* DELETE | POSIX_SEMANTICS; no path re-resolution */
  int ok=SetFileInformationByHandle(r->value,(FILE_INFO_BY_HANDLE_CLASS)21,&disposition,sizeof(disposition));
#else
  /* As on the existing Linux path, leaf comparison/unlink is not atomic against same-UID mutation. */
  int ok=unlinkat(p->value,name,directory?AT_REMOVEDIR:0)==0;
#endif
  free(name);if(!ok){napi_value error=osfail(env,"Native relative deletion failed");close_resource(r);free(r);return error;}
  close_resource(r);free(r);return nothing(env);
}
static napi_value close_handle(napi_env env,napi_callback_info info) {
  napi_value a[1];if(!args(env,info,1,a))return NULL;resource *r=NULL;
  if(napi_get_value_external(env,a[0],(void**)&r)!=napi_ok||!r||r->magic!=MAGIC)return fail(env,"Invalid native resource","EINVAL");
  close_resource(r);return nothing(env);
}
static napi_value list_entries(napi_env env,napi_callback_info info) {
  napi_value a[1],result;if(!args(env,info,1,a))return NULL;resource *r=get_resource(env,a[0],1);if(!r)return NULL;
  napi_create_array(env,&result);uint32_t count=0;
#ifdef _WIN32
  char buffer[65536];int first=1;
  for(;;){
    if(!GetFileInformationByHandleEx(r->value,first?FileIdBothDirectoryRestartInfo:FileIdBothDirectoryInfo,buffer,sizeof(buffer))){
      if(GetLastError()==ERROR_NO_MORE_FILES)break;return osfail(env,"Native directory listing failed");}
    first=0;FILE_ID_BOTH_DIR_INFO *entry=(FILE_ID_BOTH_DIR_INFO*)buffer;
    for(;;){
      size_t length=entry->FileNameLength/sizeof(wchar_t);
      if(!(length==1&&entry->FileName[0]==L'.')&&!(length==2&&entry->FileName[0]==L'.'&&entry->FileName[1]==L'.')){
        if(count>=MAX_ENTRIES)return fail(env,"Native directory exceeds limit","E2BIG");
        napi_value name;napi_create_string_utf16(env,(char16_t*)entry->FileName,length,&name);napi_set_element(env,result,count++,name);
      }
      if(!entry->NextEntryOffset)break;entry=(FILE_ID_BOTH_DIR_INFO*)((char*)entry+entry->NextEntryOffset);
    }
  }
#else
  int duplicate=openat(r->value,".",O_RDONLY|O_DIRECTORY|O_CLOEXEC);if(duplicate<0)return osfail(env,"Native listing descriptor failed");
  DIR *dir=fdopendir(duplicate);if(!dir){close(duplicate);return osfail(env,"Native directory listing failed");}
  errno=0;struct dirent *entry;
  while((entry=readdir(dir))){if(!strcmp(entry->d_name,".")||!strcmp(entry->d_name,".."))continue;
    if(count>=MAX_ENTRIES){closedir(dir);return fail(env,"Native directory exceeds limit","E2BIG");}
    napi_value name;napi_create_string_utf8(env,entry->d_name,NAPI_AUTO_LENGTH,&name);napi_set_element(env,result,count++,name);errno=0;
  }
  int error=errno;closedir(dir);if(error){errno=error;return osfail(env,"Native directory listing failed");}
#endif
  return result;
}
static napi_value read_file(napi_env env,napi_callback_info info) {
  napi_value a[2],result;if(!args(env,info,2,a))return NULL;resource *r=get_resource(env,a[0],1);if(!r)return NULL;
  uint32_t limit;if(napi_get_value_uint32(env,a[1],&limit)!=napi_ok||limit>MAX_BYTES)return fail(env,"Invalid native read limit","EINVAL");
  metadata before,after;if(!stat_resource(r,&before)||!before.regular||before.links!=1||before.size>limit)return fail(env,"Unsafe native read","EINVAL");
  void *buffer;if(napi_create_buffer(env,(size_t)before.size,&buffer,&result)!=napi_ok)return fail(env,"Native allocation failed","ENOMEM");
  size_t offset=0;
#ifdef _WIN32
  LARGE_INTEGER start;start.QuadPart=0;if(!SetFilePointerEx(r->value,start,NULL,FILE_BEGIN))return osfail(env,"Cannot seek native file");
#endif
  while(offset<before.size){
#ifdef _WIN32
    DWORD got=0;if(!ReadFile(r->value,(char*)buffer+offset,(DWORD)(before.size-offset),&got,NULL))return osfail(env,"Native read failed");
#else
    ssize_t got=pread(r->value,(char*)buffer+offset,(size_t)before.size-offset,(off_t)offset);if(got<0)return osfail(env,"Native read failed");
#endif
    if(!got)return fail(env,"Native file changed during read","ESTALE");
    offset+=(size_t)got;
  }
  if(!stat_resource(r,&after)||before.dev!=after.dev||before.ino!=after.ino||before.size!=after.size||before.mtime!=after.mtime||after.links!=1)return fail(env,"Native file changed during read","ESTALE");
  return result;
}

#ifdef _WIN32
static napi_value create_job(napi_env env,napi_callback_info info) {
  napi_value a[1];if(!args(env,info,1,a))return NULL;char *name=string_arg(env,a[0]);if(!name)return NULL;
  wchar_t *text=wide(name);free(name);if(!text)return fail(env,"Invalid job name","EINVAL");
  HANDLE job=CreateJobObjectW(NULL,text);free(text);
  if(!job)return osfail(env,"Cannot create managed job");
  if(GetLastError()==ERROR_ALREADY_EXISTS){CloseHandle(job);return fail(env,"Managed job already exists","EEXIST");}
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;memset(&limits,0,sizeof(limits));limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits))){CloseHandle(job);return osfail(env,"Cannot constrain managed job");}
  resource *r=calloc(1,sizeof(*r));if(!r){CloseHandle(job);return fail(env,"Native allocation failed","ENOMEM");}r->kind=2;r->value=job;return wrap(env,r);
}
static napi_value join_job(napi_env env,napi_callback_info info) {
  napi_value a[1];if(!args(env,info,1,a))return NULL;char *name=string_arg(env,a[0]);if(!name)return NULL;
  wchar_t *text=wide(name);free(name);if(!text)return fail(env,"Invalid job name","EINVAL");
  HANDLE job=OpenJobObjectW(JOB_OBJECT_ASSIGN_PROCESS|JOB_OBJECT_QUERY,FALSE,text);free(text);
  if(!job)return osfail(env,"Cannot open managed job");
  BOOL ok=AssignProcessToJobObject(job,GetCurrentProcess());CloseHandle(job);
  if(!ok)return osfail(env,"Cannot join managed job before backend startup");return nothing(env);
}
static napi_value job_member(napi_env env,napi_callback_info info) {
  napi_value a[2],result;if(!args(env,info,2,a))return NULL;resource *r=get_resource(env,a[0],2);if(!r)return NULL;
  uint32_t pid;if(napi_get_value_uint32(env,a[1],&pid)!=napi_ok)return fail(env,"Invalid managed PID","EINVAL");
  HANDLE process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid);if(!process)return osfail(env,"Cannot inspect managed process");
  BOOL member=FALSE;BOOL ok=IsProcessInJob(process,r->value,&member);CloseHandle(process);
  if(!ok)return osfail(env,"Cannot inspect job membership");napi_get_boolean(env,member,&result);return result;
}
static napi_value job_count(napi_env env,napi_callback_info info) {
  napi_value a[1],result;if(!args(env,info,1,a))return NULL;resource *r=get_resource(env,a[0],2);if(!r)return NULL;
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info_value;
  if(!QueryInformationJobObject(r->value,JobObjectBasicAccountingInformation,&info_value,sizeof(info_value),NULL))return osfail(env,"Cannot query managed job");
  napi_create_uint32(env,info_value.ActiveProcesses,&result);return result;
}
static napi_value terminate_job(napi_env env,napi_callback_info info) {
  napi_value a[1];if(!args(env,info,1,a))return NULL;resource *r=get_resource(env,a[0],2);if(!r)return NULL;
  if(!TerminateJobObject(r->value,1))return osfail(env,"Cannot stop managed job");return nothing(env);
}
#endif
#ifdef __APPLE__
static napi_value process_info(napi_env env,napi_callback_info info) {
  napi_value a[1],result,value;if(!args(env,info,1,a))return NULL;int32_t pid;
  if(napi_get_value_int32(env,a[0],&pid)!=napi_ok||pid<=0)return fail(env,"Invalid process identity","EINVAL");
  struct proc_bsdinfo info_value;int n=proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info_value,sizeof(info_value));
  if(n!=sizeof(info_value))return osfail(env,"Cannot inspect managed process");
  pid_t session=getsid(pid);if(session<0)return osfail(env,"Cannot inspect process session");
  napi_create_object(env,&result);
#define INT_FIELD(key,num) napi_create_int64(env,(num),&value);napi_set_named_property(env,result,key,value)
  INT_FIELD("pid",pid);INT_FIELD("group",info_value.pbi_pgid);INT_FIELD("session",session);
  napi_create_string_utf8(env,info_value.pbi_status==SZOMB?"Z":"R",NAPI_AUTO_LENGTH,&value);napi_set_named_property(env,result,"state",value);
  number_string(env,result,"birth",(uint64_t)info_value.pbi_start_tvsec*1000000+info_value.pbi_start_tvusec);return result;
}
static napi_value process_ids(napi_env env,napi_callback_info info) {
  napi_value a[1];if(!args(env,info,1,a))return NULL;uint32_t group;
  if(napi_get_value_uint32(env,a[0],&group)!=napi_ok||group<=1)return fail(env,"Invalid process group","EINVAL");
  int size=proc_listpids(PROC_PGRP_ONLY,group,NULL,0);if(size<0||size>(int)(MAX_ENTRIES*sizeof(pid_t)))return fail(env,"Process inventory unavailable","EIO");
  int capacity=size/(int)sizeof(pid_t)+1024;pid_t *pids=calloc(capacity,sizeof(pid_t));if(!pids)return fail(env,"Native allocation failed","ENOMEM");
  int bytes=proc_listpids(PROC_PGRP_ONLY,group,pids,capacity*sizeof(pid_t));
  if(bytes<0||bytes>=(int)(capacity*sizeof(pid_t))){free(pids);return fail(env,"Incomplete process inventory","EIO");}
  int count=bytes/(int)sizeof(pid_t);
  napi_value result;napi_create_array(env,&result);for(int i=0;i<count;i++){char text[32];snprintf(text,sizeof(text),"%d",pids[i]);napi_value value;napi_create_string_utf8(env,text,NAPI_AUTO_LENGTH,&value);napi_set_element(env,result,i,value);}free(pids);return result;
}
#endif
static napi_value init(napi_env env,napi_value exports) {
#define EXPORT(name,fn) {napi_value value;napi_create_function(env,name,NAPI_AUTO_LENGTH,fn,NULL,&value);napi_set_named_property(env,exports,name,value);}
  EXPORT("openRoot",open_root);EXPORT("openChild",open_child);EXPORT("stat",stat_handle);EXPORT("openEntry",open_entry);EXPORT("remove",remove_child);
  EXPORT("close",close_handle);EXPORT("entries",list_entries);EXPORT("read",read_file);
#ifdef _WIN32
  EXPORT("jobMember",job_member);EXPORT("createJob",create_job);EXPORT("joinJob",join_job);EXPORT("jobCount",job_count);EXPORT("terminateJob",terminate_job);
#endif
#ifdef __APPLE__
  EXPORT("processInfo",process_info);EXPORT("processIds",process_ids);
#endif
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
