import { createRequire } from 'node:module';
import path from 'node:path';

const { workspaceRequestAllowed } = createRequire(__filename)(
  path.resolve(process.cwd(), 'provisioner/hivra-chat/workspace-access-policy.cjs'),
) as { workspaceRequestAllowed: (surface: string, request: { url: string; method: string; headers?: Record<string, string> }) => boolean };

const request = (url: string, method = 'GET', upgrade?: string): { url: string; method: string; headers: Record<string, string> } => (
  { url, method, headers: upgrade ? { upgrade } : {} }
);

describe('owner-bound workspace request policy (not grant authentication)', () => {
  it.each(['/api/files', '/api/files?path=.', '/api/file?path=notes%2Fhello.txt'])(
    'permits the files service route %s', url => expect(workspaceRequestAllowed('files', request(url))).toBe(true),
  );
  it('permits file writes only through the existing guarded writer', () => {
    expect(workspaceRequestAllowed('files', request('/api/file', 'POST'))).toBe(true);
    expect(workspaceRequestAllowed('files', request('/api/files', 'POST'))).toBe(false);
    expect(workspaceRequestAllowed('files', request('/api/file?path=ignored', 'POST'))).toBe(false);
  });
  it.each(['/api/files?path=a&path=b', '/api/file?token=a', '/api/file?path=a&other=b', '/api/file/extra',
    '/api/model', '/api/llm', '/auth/bootstrap', '/api/telegram/connect', '/desktop/handoff', '/terminal/',
    '//elsewhere.test/api/file', '/x/../api/file', '/api/%66ile', '/api/file#fragment', '/api\\file'])(
    'rejects route or parameter escalation %s', url => expect(workspaceRequestAllowed('files', request(url))).toBe(false),
  );
  it.each(['DELETE', 'PUT', 'PATCH', 'OPTIONS', 'HEAD', 'get'])('rejects unsupported files method %s', method => {
    expect(workspaceRequestAllowed('files', request('/api/file', method))).toBe(false);
  });
  it('rejects file websocket upgrades', () => expect(workspaceRequestAllowed('files', request('/api/file', 'GET', 'websocket'))).toBe(false));
  it('permits only the box ttyd document, token and websocket routes', () => {
    expect(workspaceRequestAllowed('box-terminal', request('/box-terminal/'))).toBe(true);
    expect(workspaceRequestAllowed('box-terminal', request('/box-terminal/token'))).toBe(true);
    expect(workspaceRequestAllowed('box-terminal', request('/box-terminal/ws', 'GET', 'websocket'))).toBe(true);
    expect(workspaceRequestAllowed('box-terminal', request('/box-terminal/ws'))).toBe(false);
  });
  it.each(['/api/files', '/api/file', '/api/model', '/terminal/', '/box-terminal/?token=secret',
    '/box-terminal/token?arg=1', '/box-terminal/../api/files', '/box-terminal/anything'])(
    'rejects non-shell authority %s', url => expect(workspaceRequestAllowed('box-terminal', request(url))).toBe(false),
  );
  it('rejects unsupported shell methods and upgrades', () => {
    expect(workspaceRequestAllowed('box-terminal', request('/box-terminal/', 'POST'))).toBe(false);
    expect(workspaceRequestAllowed('box-terminal', request('/box-terminal/ws', 'GET', 'h2c'))).toBe(false);
    expect(workspaceRequestAllowed('box-terminal', request('/box-terminal/', 'GET', 'websocket'))).toBe(false);
  });
  it('requires one explicit known surface', () => {
    for (const surface of ['', 'all', 'desktop', 'files,box-terminal']) {
      expect(workspaceRequestAllowed(surface, request('/api/files'))).toBe(false);
    }
  });
  it('rejects oversized and control-character request targets', () => {
    for (const url of ['/api/files?path=' + 'a'.repeat(8192), '/api/files\n', '/api/file?path=two words']) {
      expect(workspaceRequestAllowed('files', request(url))).toBe(false);
    }
  });
});
