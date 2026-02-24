# File Transfer Design Plan

## Executive Summary

This document outlines the design for implementing file transfer functionality in the remote-cli system. The goal is to enable users to upload files from their mobile devices (via Feishu) to their local development machines running the CLI client, and vice versa.

## Current Architecture Analysis

### Message Flow Architecture

```
User's Phone → Feishu → Router Server → WebSocket → Local CLI → Claude Code
                                                                      ↓
User's Phone ← Feishu ← Router Server ← WebSocket ← Local CLI ← Results
```

### Key Components

1. **CLI Side** (`packages/cli/`):
   - WebSocket Client: Text-based JSON message protocol
   - Security: DirectoryGuard enforces whitelist for file operations
   - Executor: ClaudeExecutor interfaces with Claude Code

2. **Router Side** (`packages/router/`):
   - ConnectionHub: Manages WebSocket connections to CLI clients
   - FeishuLongConnHandler: Handles Feishu messages (text only currently)
   - FeishuClient: API wrapper for sending text messages

3. **Messaging Protocol**:
   - CLI → Router: `IncomingMessage` (command, status, ping)
   - Router → CLI: `OutgoingMessage` (result, progress, status, pong)
   - Both sides use JSON over WebSocket text frames

### Current Limitations

1. **No binary data support**: Only text-based JSON messages
2. **No file handling**: Feishu handlers only parse text messages (line 88-91 in FeishuLongConnHandler.ts)
3. **No file storage**: No temporary storage for uploaded files
4. **Size limits**: WebSocket text frames + JSON serialization overhead

## Requirements

### Functional Requirements

1. **Upload Files (Phone → CLI)**:
   - User sends file/image via Feishu
   - File is downloaded from Feishu server
   - File is transmitted to target local CLI device
   - File is saved to specified directory (respecting security whitelist)
   - User receives confirmation with file path

2. **Download Files (CLI → Phone)**:
   - User requests file via text command (e.g., "send me config.json")
   - Claude Code generates file or reads existing file
   - File is transmitted to router
   - File is uploaded to Feishu
   - User receives file in Feishu chat

3. **Security**:
   - Directory whitelist enforcement (DirectoryGuard)
   - File size limits
   - File type validation (optional)
   - Path traversal prevention

### Non-Functional Requirements

1. **Performance**:
   - Support files up to 20MB (Feishu upload limit)
   - Chunked transfer for large files
   - Progress reporting for transfers > 1MB

2. **Reliability**:
   - Resume capability for interrupted transfers
   - Checksum verification (MD5/SHA-256)
   - Timeout handling

3. **User Experience**:
   - Clear progress indicators
   - Error messages with actionable guidance
   - Support for multiple file uploads in one message

## Design Options Analysis

### Option 1: Base64 over WebSocket Text Frames

**Approach**: Encode file binary data as Base64, embed in JSON message

**Pros**:
- Minimal protocol changes
- Works with existing WebSocket text-based infrastructure
- Simple implementation

**Cons**:
- 33% overhead (Base64 encoding)
- Large memory footprint for big files
- No native chunking support (need custom implementation)
- Poor performance for files > 5MB

**Verdict**: ❌ Not recommended for production use

---

### Option 2: WebSocket Binary Frames

**Approach**: Send file metadata as JSON text frame, then send file content as binary frames

**Pros**:
- No encoding overhead
- Native binary support
- Efficient memory usage
- Good for files up to 20MB

**Cons**:
- Requires protocol refactoring
- Need to handle frame sequencing
- More complex state management

**Verdict**: ✅ **Recommended for direct file transfer**

---

### Option 3: Hybrid - Feishu Cloud Storage

**Approach**:
1. Upload: Router downloads from Feishu → sends download URL to CLI → CLI downloads directly
2. Download: CLI uploads to temporary HTTP server → Router sends URL to Feishu

**Pros**:
- Minimal WebSocket changes (only send URLs)
- Feishu handles heavy lifting
- Natural integration with Feishu workflow
- No file size concerns (Feishu handles up to 30MB)

**Cons**:
- Requires HTTP server for downloads
- Additional network hop
- Dependency on Feishu cloud storage

**Verdict**: ✅ **Recommended for user-initiated uploads**

---

### Option 4: Chunked Base64 with Streaming

**Approach**: Split file into chunks, Base64 encode each chunk, send as multiple messages

**Pros**:
- Works with existing text protocol
- Supports progress reporting
- Resumable transfers
- No protocol refactoring

**Cons**:
- 33% overhead per chunk
- Complex state management (chunk reassembly)
- Still memory-intensive for large files

**Verdict**: ⚠️ Acceptable fallback option

## Recommended Hybrid Architecture

**Upload Flow (Phone → CLI):**
```
1. User sends file via Feishu
2. FeishuLongConnHandler receives Feishu message event (message_type: 'file' or 'image')
3. Handler downloads file from Feishu using file_key
4. Handler sends file metadata + download URL to CLI via WebSocket (text JSON)
5. CLI downloads file directly from Feishu or via proxy
6. CLI validates path with DirectoryGuard
7. CLI saves file to disk
8. CLI sends confirmation back to Router
9. Router sends success message to user via Feishu
```

**Download Flow (CLI → Phone):**
```
1. User requests file via text (e.g. "send me server.log")
2. Claude Code reads/generates file
3. CLI sends file metadata to Router (text JSON)
4. CLI sends file content via WebSocket Binary Frames OR chunked Base64
5. Router uploads file to Feishu using /im/v1/files API
6. Router sends file message to user with file_key
7. User receives file in Feishu chat
```

## Protocol Design

### New Message Types

**CLI Side** (`packages/cli/src/types/index.ts`):

```typescript
// Incoming from router
interface IncomingMessage {
  type: 'command' | 'status' | 'ping' | 'file_upload_request';  // NEW
  messageId: string;
  content?: string;
  workingDirectory?: string;
  openId?: string;
  timestamp: number;
  isSlashCommand?: boolean;

  // NEW: File upload metadata
  fileUpload?: {
    fileName: string;
    fileSize: number;
    mimeType: string;
    feishuFileKey: string;  // Feishu file_key for download
    targetPath?: string;     // User-specified target path (optional)
    checksum?: string;       // SHA-256 checksum
  };
}

// Outgoing to router
interface OutgoingMessage {
  type: 'result' | 'progress' | 'status' | 'pong' | 'structured' | 'stream'
       | 'file_download_request' | 'file_chunk' | 'file_complete';  // NEW
  messageId: string;
  success?: boolean;
  output?: string;
  structuredContent?: StructuredContent;
  error?: string;
  message?: string;
  status?: any;
  timestamp: number;
  workingDirectory?: string;
  openId?: string;

  // NEW: File download metadata
  fileDownload?: {
    fileName: string;
    fileSize: number;
    mimeType: string;
    sourcePath: string;      // Local file path
    checksum: string;        // SHA-256 checksum
  };

  // NEW: File chunk data
  fileChunk?: {
    chunkIndex: number;
    totalChunks: number;
    data: string;           // Base64 encoded chunk
  };
}
```

**Router Side** (`packages/router/src/types/index.ts`):

Add corresponding types to `WSMessage.data` union.

### Feishu API Integration

**Required APIs**:

1. **Download File**: GET `/im/v1/files/{file_key}`
   - Used when user sends file via Feishu
   - Returns binary file content
   - Requires bearer token authentication

2. **Upload File**: POST `/im/v1/files`
   - Used when sending file to user
   - multipart/form-data with file binary
   - Returns file_key

3. **Upload Image**: POST `/im/v1/images`
   - Optimized for images (message or avatar type)
   - Similar to file upload

4. **Send File Message**: POST `/im/v1/messages`
   - msg_type: 'file' or 'image'
   - content: { file_key: "xxx" }

### Security Validation

**DirectoryGuard Integration**:

```typescript
// In CLI executor
async handleFileUpload(message: IncomingMessage): Promise<void> {
  const fileUpload = message.fileUpload!;

  // 1. Determine target path
  const targetPath = fileUpload.targetPath
    ? fileUpload.targetPath
    : path.join(message.workingDirectory || process.cwd(), fileUpload.fileName);

  // 2. Validate path with DirectoryGuard
  const normalizedPath = this.directoryGuard.normalizePath(targetPath);
  if (!this.directoryGuard.isSafePath(normalizedPath)) {
    throw new Error(`Path ${normalizedPath} is not in allowed directories`);
  }

  // 3. Check if file already exists (prompt user for overwrite)
  // ...

  // 4. Download file from Feishu
  // 5. Verify checksum
  // 6. Save to disk
  // 7. Send confirmation
}
```

## Testing Strategy

### Phase 1: Unit Tests

**File to create**: `packages/cli/tests/FileTransferHandler.test.ts`

```typescript
describe('FileTransferHandler', () => {
  describe('handleFileUpload', () => {
    it('should reject files outside allowed directories', async () => {
      // Test DirectoryGuard integration
    });

    it('should save file to correct path within allowed directory', async () => {
      // Test happy path
    });

    it('should verify file checksum after download', async () => {
      // Test integrity check
    });

    it('should handle checksum mismatch', async () => {
      // Test error case
    });

    it('should prompt for overwrite if file exists', async () => {
      // Test overwrite scenario
    });
  });

  describe('handleFileDownload', () => {
    it('should chunk large files correctly', async () => {
      // Test chunking algorithm
    });

    it('should calculate correct checksum', async () => {
      // Test integrity
    });

    it('should reject files outside allowed directories', async () => {
      // Test security
    });
  });
});
```

**File to create**: `packages/router/tests/FeishuFileHandler.test.ts`

```typescript
describe('FeishuFileHandler', () => {
  describe('downloadFileFromFeishu', () => {
    it('should download file using file_key', async () => {
      // Mock Feishu API
    });

    it('should handle download errors gracefully', async () => {
      // Test error handling
    });

    it('should calculate checksum for downloaded file', async () => {
      // Test integrity
    });
  });

  describe('uploadFileToFeishu', () => {
    it('should upload file and return file_key', async () => {
      // Mock Feishu API
    });

    it('should handle files up to 20MB', async () => {
      // Test size limits
    });

    it('should support images and generic files', async () => {
      // Test different types
    });
  });
});
```

### Phase 2: Integration Tests

**File to create**: `packages/cli/tests/integration/FileTransfer.test.ts`

```typescript
describe('File Transfer Integration', () => {
  it('should complete full upload flow: Feishu → Router → CLI → Disk', async () => {
    // 1. Mock Feishu message event with file
    // 2. FeishuLongConnHandler downloads file
    // 3. Router sends file upload request to CLI
    // 4. CLI downloads from Feishu
    // 5. CLI validates path and saves file
    // 6. CLI sends confirmation
    // 7. Router sends success message to Feishu
    // 8. Verify file exists on disk with correct content
  });

  it('should complete full download flow: CLI → Router → Feishu → User', async () => {
    // 1. User sends text command requesting file
    // 2. Claude Code generates/reads file
    // 3. CLI sends file download request
    // 4. CLI sends file chunks to Router
    // 5. Router uploads to Feishu
    // 6. Router sends file message to user
    // 7. Verify Feishu received file with correct content
  });

  it('should reject upload to disallowed directory', async () => {
    // Security test
  });

  it('should handle network interruption during transfer', async () => {
    // Reliability test
  });

  it('should show progress for large files', async () => {
    // UX test
  });
});
```

### Phase 3: End-to-End Tests

**Manual test scenarios**:

1. **Upload image from phone**:
   - Send PNG image via Feishu
   - Verify saved to ~/Downloads/
   - Check file integrity

2. **Upload document**:
   - Send PDF via Feishu with custom path
   - Specify /path/to/project/docs/
   - Verify path validation works

3. **Download log file**:
   - Request "send me server.log"
   - Claude Code finds file
   - Receive file in Feishu chat

4. **Large file transfer**:
   - Upload 15MB video
   - Verify progress indicators
   - Check transfer completes successfully

5. **Security rejection**:
   - Try to upload to /etc/
   - Verify rejection with clear error

### Test Coverage Goals

- Unit tests: 90%+ coverage for FileTransferHandler and FeishuFileHandler
- Integration tests: Cover all happy paths + critical error paths
- E2E tests: Manual verification of user workflows

## Implementation Phases

### Phase 1: Foundation (Week 1)

**Deliverables**:
- [ ] Add Feishu file download capability to FeishuClient
- [ ] Add Feishu file upload capability to FeishuClient
- [ ] Extend message protocol types
- [ ] Write unit tests for FeishuClient file APIs (mock Feishu responses)

**Files to modify**:
- `packages/router/src/feishu/FeishuClient.ts` - Add downloadFile() and uploadFile()
- `packages/cli/src/types/index.ts` - Add file transfer message types
- `packages/router/src/types/index.ts` - Add corresponding router types
- `packages/router/tests/FeishuClient.test.ts` - Add file API tests

**Success criteria**: All unit tests pass, APIs can upload/download files from Feishu

---

### Phase 2: Upload Flow (Week 2)

**Deliverables**:
- [ ] Handle file messages in FeishuLongConnHandler
- [ ] Implement CLI FileTransferHandler for uploads
- [ ] Integrate DirectoryGuard validation
- [ ] Write integration tests for upload flow

**Files to modify**:
- `packages/router/src/feishu/FeishuLongConnHandler.ts` - Handle 'file' and 'image' message types
- `packages/cli/src/handlers/FileTransferHandler.ts` - NEW FILE
- `packages/cli/src/client/MessageHandler.ts` - Route file upload requests
- `packages/cli/tests/integration/FileTransfer.test.ts` - NEW FILE

**Success criteria**: Can send file via Feishu and have it saved to local disk in allowed directory

---

### Phase 3: Download Flow (Week 3)

**Deliverables**:
- [ ] Implement CLI file read and chunking
- [ ] Implement Router file reassembly and Feishu upload
- [ ] Integrate with Claude Code file generation
- [ ] Write integration tests for download flow

**Files to modify**:
- `packages/cli/src/handlers/FileTransferHandler.ts` - Add downloadFile()
- `packages/router/src/handlers/FileReceiver.ts` - NEW FILE
- `packages/cli/src/executor/ClaudeExecutor.ts` - Detect file generation requests

**Success criteria**: Can request file via text and receive it in Feishu chat

---

### Phase 4: Polish & Testing (Week 4)

**Deliverables**:
- [ ] Progress indicators for large files
- [ ] Error handling and user-friendly messages
- [ ] E2E testing
- [ ] Documentation updates (README, API docs)

**Files to modify**:
- All handler files - Add progress reporting
- `README.md` and `README_EN.md` - Document file transfer feature
- `CLAUDE.md` - Update with file transfer patterns

**Success criteria**: Feature is production-ready with 90%+ test coverage

## Edge Cases and Error Handling

### Edge Cases to Handle

1. **File already exists**:
   - Prompt user: "File exists. Overwrite? (yes/no)"
   - Or auto-rename: "file.txt" → "file (1).txt"

2. **Filename conflicts**:
   - sanitize filenames: remove path separators, null bytes
   - Limit filename length (255 chars)

3. **Large files (>20MB)**:
   - Reject with clear message: "File exceeds 20MB limit (Feishu restriction)"

4. **Zero-byte files**:
   - Reject with message: "Cannot upload empty files"

5. **Network interruption**:
   - Cleanup partial downloads
   - Send error message to user

6. **Checksum mismatch**:
   - Delete corrupted file
   - Prompt user to retry

### Error Messages

**User-friendly error messages**:

```typescript
const ERROR_MESSAGES = {
  FILE_TOO_LARGE: "❌ File exceeds 20MB limit. Please send smaller files.",
  PATH_NOT_ALLOWED: "❌ Cannot save to this directory. Allowed directories: {dirs}",
  FILE_EXISTS: "⚠️ File '{name}' already exists. Reply 'yes' to overwrite or specify a new name.",
  CHECKSUM_FAILED: "❌ File transfer failed (integrity check). Please retry.",
  DEVICE_OFFLINE: "❌ Device is offline. File will be transferred when device reconnects.",
  DOWNLOAD_FAILED: "❌ Failed to download file from Feishu. Please try again.",
  UPLOAD_FAILED: "❌ Failed to send file. Please check device connection.",
};
```

## Performance Considerations

### Memory Usage

- **Streaming downloads**: Don't load entire file into memory
- **Chunked uploads**: Process 1MB chunks at a time
- **Cleanup**: Delete temporary files after transfer

### Network Optimization

- **Compression**: Gzip files before transfer (optional)
- **Resume capability**: Store partial downloads with metadata
- **Concurrent transfers**: Limit to 3 simultaneous transfers per device

### Monitoring

- **Metrics to track**:
  - Transfer success rate
  - Average transfer time per MB
  - Checksum failure rate
  - Storage usage in temp directory

## Security Considerations

### Critical Security Rules

1. **Directory whitelist**: NEVER bypass DirectoryGuard
2. **Path traversal**: Reject filenames with "..", "/", "\\"
3. **File size limits**: Enforce 20MB hard limit
4. **File type validation** (optional): Restrict executable files
5. **Checksum verification**: ALWAYS verify file integrity

### Audit Logging

Log all file transfers for security audits:

```typescript
logger.info({
  event: 'file_transfer',
  direction: 'upload', // or 'download'
  userId: openId,
  deviceId: deviceId,
  fileName: fileName,
  fileSize: fileSize,
  targetPath: normalizedPath,
  checksum: checksum,
  timestamp: Date.now(),
  success: true,
});
```

## API Documentation

### Feishu File APIs

**Sources**:
- [Upload Image API](https://open.larkoffice.com/document/server-docs/im-v1/image/create)
- [Upload File API](https://open.feishu.cn/document/server-docs/docs/drive-v1/media/upload_all)
- [Download File API](https://open.feishu.cn/document/server-docs/docs/drive-v1/download/download)
- [Block Upload for Large Files](https://open.larkoffice.com/document/server-docs/docs/drive-v1/upload/multipart-upload-file-/upload_prepare)

**Key Limits**:
- Image upload: 10MB
- File upload (messages): 30MB
- File upload (drive): 20MB per chunk, multi-part for larger files

## Open Questions

1. **Resume capability**: Should we implement resume for interrupted transfers?
   - **Decision**: Phase 4 feature, not MVP

2. **File type restrictions**: Should we block executable files?
   - **Decision**: No restrictions in MVP, add optional whitelist later

3. **Multiple files**: Should we support batch uploads?
   - **Decision**: Yes, handle multiple files in one Feishu message

4. **Storage location**: Where to store temporary downloaded files before CLI picks them up?
   - **Decision**: Router uses OS temp dir, CLI downloads directly from Feishu

5. **Compression**: Should we compress files before transfer?
   - **Decision**: No, adds complexity. Feishu already handles compression.

## Conclusion

The recommended approach is a **hybrid architecture**:

- **Upload (Phone → CLI)**: Use Feishu cloud storage as intermediary, CLI downloads directly
- **Download (CLI → Phone)**: Use WebSocket binary frames or chunked Base64, Router uploads to Feishu

This provides the best balance of:
- ✅ Minimal protocol changes
- ✅ Good performance
- ✅ Strong security
- ✅ Natural user experience

**Estimated effort**: 4 weeks (1 developer full-time)

**Test coverage target**: 90%+ with unit + integration + E2E tests

**Next steps**:
1. Review this design with team
2. Start Phase 1 implementation
3. Write comprehensive tests FIRST (TDD approach)
4. Iterate based on test results
