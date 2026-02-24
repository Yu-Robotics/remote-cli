import { describe, it, expect } from 'vitest'
import {
  shouldSkipHint,
  hasFileReadIntent,
  injectFileReadHint,
  processFileReadContent,
} from '../src/utils/FileReadDetector'

describe('FileReadDetector', () => {
  describe('shouldSkipHint', () => {
    it('should return false for empty input', () => {
      expect(shouldSkipHint('')).toBe(false)
    })

    it('should return false for null/undefined input', () => {
      expect(shouldSkipHint(null as any)).toBe(false)
      expect(shouldSkipHint(undefined as any)).toBe(false)
    })

    it('should return true for --full marker', () => {
      expect(shouldSkipHint('read file.ts --full')).toBe(true)
    })

    it('should return true for --FULL (case insensitive)', () => {
      expect(shouldSkipHint('read file.ts --FULL')).toBe(true)
    })

    it('should return true for 全部显示 marker', () => {
      expect(shouldSkipHint('读取 config.ts 全部显示')).toBe(true)
    })

    it('should return false when no markers present', () => {
      expect(shouldSkipHint('read file.ts')).toBe(false)
      expect(shouldSkipHint('读取 config.ts')).toBe(false)
    })
  })

  describe('hasFileReadIntent', () => {
    it('should return false for empty input', () => {
      expect(hasFileReadIntent('')).toBe(false)
    })

    it('should return false for null/undefined input', () => {
      expect(hasFileReadIntent(null as any)).toBe(false)
      expect(hasFileReadIntent(undefined as any)).toBe(false)
    })

    describe('Chinese keywords', () => {
      it('should detect 读取 keyword', () => {
        expect(hasFileReadIntent('读取 config.ts')).toBe(true)
      })

      it('should detect 查看 keyword', () => {
        expect(hasFileReadIntent('查看 package.json')).toBe(true)
      })

      it('should detect 看看 keyword', () => {
        expect(hasFileReadIntent('看看 main.py')).toBe(true)
      })

      it('should detect 展示 keyword', () => {
        expect(hasFileReadIntent('展示 index.html')).toBe(true)
      })

      it('should detect 显示 keyword', () => {
        expect(hasFileReadIntent('显示文件内容')).toBe(true)
      })

      it('should detect 打开文件 keyword', () => {
        expect(hasFileReadIntent('打开文件 test.js')).toBe(true)
      })

      it('should detect 文件内容 keyword', () => {
        expect(hasFileReadIntent('看一下文件内容')).toBe(true)
      })

      it('should detect 看下 keyword', () => {
        expect(hasFileReadIntent('看下 utils.ts')).toBe(true)
      })

      it('should detect 看一下 keyword', () => {
        expect(hasFileReadIntent('看一下 config.yaml')).toBe(true)
      })
    })

    describe('English phrases', () => {
      it('should detect "read file" phrase', () => {
        expect(hasFileReadIntent('read file src/main.ts')).toBe(true)
      })

      it('should detect "show the file" phrase', () => {
        expect(hasFileReadIntent('show the file')).toBe(true)
      })

      it('should detect "view file" phrase', () => {
        expect(hasFileReadIntent('view file package.json')).toBe(true)
      })

      it('should detect "display file" phrase', () => {
        expect(hasFileReadIntent('display file contents')).toBe(true)
      })

      it('should detect "open file" phrase', () => {
        expect(hasFileReadIntent('open file README.md')).toBe(true)
      })

      it('should detect "show me" phrase', () => {
        expect(hasFileReadIntent('show me the contents')).toBe(true)
      })

      it('should detect "cat" command', () => {
        expect(hasFileReadIntent('cat /etc/hosts')).toBe(true)
      })

      it('should detect "print file" phrase', () => {
        expect(hasFileReadIntent('print file output.log')).toBe(true)
      })
    })

    describe('file path + action verb', () => {
      it('should detect "show src/index.ts"', () => {
        expect(hasFileReadIntent('show src/index.ts')).toBe(true)
      })

      it('should detect "看 config.yaml"', () => {
        expect(hasFileReadIntent('看 config.yaml')).toBe(true)
      })

      it('should detect "read package.json"', () => {
        expect(hasFileReadIntent('read package.json')).toBe(true)
      })

      it('should detect "open test.py"', () => {
        expect(hasFileReadIntent('open test.py')).toBe(true)
      })
    })

    describe('negative cases', () => {
      it('should not detect "fix the bug"', () => {
        expect(hasFileReadIntent('fix the bug')).toBe(false)
      })

      it('should not detect "write a function"', () => {
        expect(hasFileReadIntent('write a function')).toBe(false)
      })

      it('should not detect "refactor the service"', () => {
        expect(hasFileReadIntent('refactor the service')).toBe(false)
      })

      it('should not detect "deploy to production"', () => {
        expect(hasFileReadIntent('deploy to production')).toBe(false)
      })

      it('should not detect "run the tests"', () => {
        expect(hasFileReadIntent('run the tests')).toBe(false)
      })

      it('should not detect plain text without keywords', () => {
        expect(hasFileReadIntent('hello world')).toBe(false)
      })
    })
  })

  describe('injectFileReadHint', () => {
    it('should return empty string for empty input', () => {
      expect(injectFileReadHint('')).toBe('')
    })

    it('should append system hint to content', () => {
      const result = injectFileReadHint('read config.ts')

      expect(result).toContain('read config.ts')
      expect(result).toContain('[System hint:')
      expect(result).toContain('50 lines')
    })

    it('should separate hint with double newline', () => {
      const result = injectFileReadHint('test content')

      expect(result).toBe('test content\n\n[System hint: For files exceeding 50 lines, show only the first 50 lines by default with a summary of remaining content. Ask the user if they want to see more.]')
    })
  })

  describe('processFileReadContent', () => {
    it('should return falsy input unchanged', () => {
      expect(processFileReadContent('')).toBe('')
      expect(processFileReadContent(null as any)).toBe(null)
      expect(processFileReadContent(undefined as any)).toBe(undefined)
    })

    it('should inject hint for file read intent', () => {
      const result = processFileReadContent('读取 config.ts')

      expect(result).toContain('读取 config.ts')
      expect(result).toContain('[System hint:')
      expect(result).toContain('50 lines')
    })

    it('should not modify non-file-read content', () => {
      const content = 'fix the login bug'
      const result = processFileReadContent(content)

      expect(result).toBe(content)
    })

    it('should strip --full and skip hint', () => {
      const result = processFileReadContent('read file.ts --full')

      expect(result).toBe('read file.ts')
      expect(result).not.toContain('--full')
      expect(result).not.toContain('[System hint:')
    })

    it('should strip 全部显示 and skip hint', () => {
      const result = processFileReadContent('读取 config.ts 全部显示')

      expect(result).toBe('读取 config.ts')
      expect(result).not.toContain('全部显示')
      expect(result).not.toContain('[System hint:')
    })

    it('should handle --FULL case insensitively', () => {
      const result = processFileReadContent('show file.ts --FULL')

      expect(result).toBe('show file.ts')
      expect(result).not.toContain('[System hint:')
    })

    it('should inject hint for English read commands', () => {
      const result = processFileReadContent('show me the code')

      expect(result).toContain('[System hint:')
    })

    it('should inject hint for cat commands', () => {
      const result = processFileReadContent('cat /etc/hosts')

      expect(result).toContain('[System hint:')
    })
  })
})
