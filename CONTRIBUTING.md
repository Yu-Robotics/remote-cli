# Contributing to Remote CLI

Thank you for your interest in contributing to Remote CLI! This document provides guidelines and instructions for contributing.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Contributing Guidelines](#contributing-guidelines)
- [Pull Request Process](#pull-request-process)
- [Testing Requirements](#testing-requirements)
- [Commit Message Guidelines](#commit-message-guidelines)
- [Release Process](#release-process)

## Code of Conduct

This project and everyone participating in it is governed by our commitment to:

- Be respectful and inclusive
- Welcome newcomers and help them get started
- Focus on constructive feedback
- Accept responsibility and apologize when mistakes happen

## Getting Started

1. Fork the repository on GitHub
2. Clone your fork locally
3. Create a new branch for your feature or bug fix
4. Make your changes
5. Submit a pull request

## Development Setup

### Prerequisites

- Node.js >= 18.0.0
- npm >= 9.0.0
- Git

### Installation

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/remote-cli.git
cd remote-cli

# Install locked dependencies from the repository root
npm ci

# Build all packages
npm run build

# Run tests to verify setup
npm test
```

### Project Structure

```
remote-cli/
├── packages/
│   ├── cli/           # Local client package
│   │   ├── src/       # Source code
│   │   ├── tests/     # Test files
│   │   └── bin/       # CLI entry point
│   └── router/        # Router server package
│       ├── src/       # Source code
│       ├── tests/     # Test files
│       └── bin/       # CLI entry point
├── docs/              # Documentation
└── package.json       # Root package.json
```

## Contributing Guidelines

### Language Requirements

**IMPORTANT**: All code, comments, documentation, commit messages, and variable names MUST be written in **English only**.

- No Chinese characters in source files, comments, or documentation
- All JSDoc comments must be in English
- All error messages and user-facing strings must be in English
- Commit messages must be in English
- Variable names and function names must use English words

### Code Style

We use TypeScript with strict type checking. Please ensure:

- All code is properly typed
- No `any` types unless absolutely necessary
- Follow existing code patterns and conventions
- Use meaningful variable and function names
- Add JSDoc comments for public APIs

### Testing Requirements

**All code changes MUST include corresponding test coverage.**

- **Minimum coverage**: 80%
- **Test types required**:
  - Unit tests for individual functions/utilities
  - Integration tests for workflows
  - Command tests for CLI commands

```bash
# Run all tests
npm test

# Run tests for specific package
npm test -w @yu_robotics/remote-cli

# Run tests with coverage
npm run test:coverage -w @yu_robotics/remote-cli

# Run specific test file
npm test -w @yu_robotics/remote-cli -- DirectoryGuard.test.ts
```

### Test-Driven Development

We follow TDD principles:

1. **Write test first** (RED)
2. Run test - it should FAIL
3. Write minimal implementation (GREEN)
4. Run test - it should PASS
5. Refactor (IMPROVE)
6. Verify coverage (80%+)

## Pull Request Process

1. **Create a branch** from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/bug-description
   ```

2. **Make your changes** following our guidelines

3. **Run tests** and ensure they pass:
   ```bash
   npm test
   ```

4. **Update documentation** if needed:
   - README.md for user-facing changes
   - CLAUDE.md for architecture changes
   - Inline code comments

5. **Commit your changes** with a descriptive message (see [Commit Guidelines](#commit-message-guidelines))

6. **Push to your fork**:
   ```bash
   git push origin feature/your-feature-name
   ```

7. **Create a Pull Request** on GitHub:
   - Provide a clear title and description
   - Reference any related issues
   - Ensure all CI checks pass
   - Request review from maintainers

### PR Review Criteria

Your PR will be reviewed for:

- Code quality and readability
- Test coverage (minimum 80%)
- Documentation updates
- Adherence to style guidelines
- No breaking changes (unless discussed)

## Commit Message Guidelines

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, semicolons, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Build process or auxiliary tool changes

### Examples

```
feat(cli): add worktree cleanup command

Add /worktree cleanup slash command to remove old worktrees
automatically. Default cleanup threshold is 7 days.

Closes #123
```

```
fix(router): handle WebSocket reconnection gracefully

Prevent crash when WebSocket connection drops unexpectedly.
Add exponential backoff for reconnection attempts.

Fixes #456
```

```
docs: update README with new configuration options

Add documentation for worktree configuration settings.
```

## Testing Requirements

### Unit Tests

Test individual components in isolation:

```typescript
// packages/cli/tests/DirectoryGuard.test.ts
import { describe, it, expect } from 'vitest';
import { DirectoryGuard } from '../src/security/DirectoryGuard';

describe('DirectoryGuard', () => {
  it('should allow paths within whitelist', () => {
    const guard = new DirectoryGuard(['/home/user/projects']);
    expect(guard.isAllowed('/home/user/projects/my-app')).toBe(true);
  });
});
```

### Integration Tests

Test complete workflows:

```typescript
// packages/cli/tests/integration/full-workflow.test.ts
describe('Integration: Full Workflow', () => {
  it('should complete init → start → stop workflow', async () => {
    // Test the complete user journey
  });
});
```

### Test Isolation

Tests must be isolated and not depend on each other:

```typescript
import { vi } from 'vitest';
import os from 'os';

// Capture the original function before mocking to avoid recursive fallback.
const originalHomedir = os.homedir.bind(os);
vi.spyOn(os, 'homedir').mockImplementation(() => process.env.HOME || originalHomedir());
```

## Release Process

1. Keep the version synchronized in the root, CLI, and Router `package.json` files and `package-lock.json`. Runtime behavior changes require a version bump; documentation-only and test-only changes do not.
2. Review both root README files and update them together when user-visible behavior changes. Add matching, nonempty version entries to `CHANGELOG.md` and `RELEASE_NOTES_ZH.md`, following the release-summary requirements in `CLAUDE.md`.
3. From the repository root, run `npm ci`, `npm run build`, and `npm test`.
4. Review the exact staged changes and outgoing commit range for secrets and private information before an authorized commit and push. The [publishing workflow](.github/workflows/npm-publish.yml) builds and tests both packages on native Linux, macOS, and Windows for pushes to `main` and pull requests targeting `main`. Pull requests do not publish. A push to the upstream `main` selects publication only when the root version increases relative to the revision before that push; unchanged versions skip publication, while invalid versions, downgrades, or unreadable prior versions fail closed. A Git tag is not required and does not trigger publication.
5. After all native jobs succeed, the workflow uses npm Trusted Publishing (OIDC) and [scripts/publish-npm.cjs](scripts/publish-npm.cjs) to validate synchronized versions, pack both packages, check both exact registry versions for integrity conflicts, and publish missing packages. Existing versions are skipped only when their integrity matches the local tarball. The helper confirms each publication against registry metadata with bounded polling; an uncertain result never triggers an automatic upload retry. Publication of the two packages is not atomic.

For partial or uncertain publication, reconcile the registry result and use **Re-run failed jobs** on the original run to preserve its source revision and integrity checks. Do not change the source and reuse a partially published version. Explicit `workflow_dispatch` recovery is also available on upstream `main` with its exact committed version; it runs the same native validation and publication gates. Direct workspace `npm publish` retains `prepublishOnly` build/test checks but is not the normal release procedure. See [Publishing with GitHub Actions](README.md#publishing-with-github-actions) for trusted-publisher setup and recovery details.

## Questions?

- Open an issue for bugs or feature requests
- Start a discussion for questions or ideas
- Join our community chat (if available)

Thank you for contributing!
