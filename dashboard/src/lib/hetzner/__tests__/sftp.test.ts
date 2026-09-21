import { sftpList, sftpRead, sftpReadBinary, sftpRealpath, sftpWrite } from '../sftp';
import { Client } from 'ssh2';

jest.mock('ssh2');
jest.mock('../ssh', () => ({
  isProxmoxPrivateGuestIp: jest.fn(() => false),
  resolveSshConnectConfig: jest.fn().mockResolvedValue({
    host: '203.0.113.4',
    port: 22,
    username: 'root',
    privateKey: 'mock-private-key',
    readyTimeout: 15_000,
  }),
  sshExec: jest.fn(),
}));

import { isProxmoxPrivateGuestIp, resolveSshConnectConfig, sshExec } from '../ssh';

describe('sftp', () => {
  let mockConn: {
    on: jest.Mock;
    connect: jest.Mock;
    sftp: jest.Mock;
    end: jest.Mock;
  };
  let mockSftp: {
    readdir: jest.Mock;
    realpath: jest.Mock;
    stat: jest.Mock;
    readFile: jest.Mock;
    writeFile: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();

      mockSftp = {
        readdir: jest.fn(),
        realpath: jest.fn(),
        stat: jest.fn(),
        readFile: jest.fn(),
        writeFile: jest.fn()
    };

    mockConn = {
      on: jest.fn().mockReturnThis(),
      connect: jest.fn().mockImplementation(function(this: unknown) {
        // Simulate immediate connection success
        setTimeout(() => {
          const readyHandler = mockConn.on.mock.calls.find((call: unknown[]) => call[0] === 'ready')?.[1] as () => void;
          readyHandler?.();
        }, 0);
        return this;
      }),
      sftp: jest.fn().mockImplementation((cb) => {
        cb(null, mockSftp);
      }),
      end: jest.fn()
    };

    (Client as unknown as jest.Mock).mockImplementation(() => mockConn);
  });

  describe('sftpList', () => {
    it('routes Proxmox private guest IP listings through the SSH bastion helper', async () => {
      const ip = '10.250.20.51';
      (isProxmoxPrivateGuestIp as jest.Mock).mockReturnValueOnce(true);
      (sshExec as jest.Mock).mockResolvedValueOnce({
        ok: true,
        stdout: JSON.stringify({
          ok: true,
          files: [
            { name: 'notes.txt', type: 'file', size: 42, modifyTime: 1710000000 },
          ],
        }),
        stderr: '',
      });

      const result = await sftpList(ip, '/opt/hermes/instances/inst-123');

      expect(result).toEqual([
        { name: 'notes.txt', type: 'file', size: 42, modifyTime: 1710000000 },
      ]);
      expect(sshExec).toHaveBeenCalledWith(
        ip,
        expect.stringContaining('python3 -c'),
        expect.objectContaining({
          stdin: JSON.stringify({ action: 'list', path: '/opt/hermes/instances/inst-123' }),
        })
      );
      expect(resolveSshConnectConfig).not.toHaveBeenCalled();
      expect(Client).not.toHaveBeenCalled();
    });

    it('sorts directories first, then alphabetically', async () => {
      const ip = '203.0.113.11';
      mockSftp.readdir.mockImplementation((_path: string, cb: (err: Error | null, list: unknown[]) => void) => {
        cb(null, [
          { filename: 'zebra.txt', attrs: { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, size: 10, mtime: 123 } },
          { filename: 'apple.txt', attrs: { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, size: 10, mtime: 123 } },
          { filename: 'assets', attrs: { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, size: 0, mtime: 123 } },
        ]);
      });

      const result = await sftpList(ip, '/root');
      
      expect(result).toHaveLength(3);
      expect(result[0].name).toBe('assets'); // Directory
      expect(result[0].type).toBe('directory');
      expect(result[1].name).toBe('apple.txt'); // File
      expect(result[2].name).toBe('zebra.txt'); // File
      expect(resolveSshConnectConfig).toHaveBeenCalledWith(ip, 15_000);
      expect(mockConn.connect).toHaveBeenCalledWith(expect.objectContaining({ host: '203.0.113.4' }));
    });

    it('rejects on connection error', async () => {
      const ip = '203.0.113.12';
      mockConn.connect = jest.fn().mockImplementation(function(this: unknown) {
        setTimeout(() => {
          const errorHandler = mockConn.on.mock.calls.find((call: unknown[]) => call[0] === 'error')?.[1] as (e: Error) => void;
          errorHandler?.(new Error('Connection failed'));
        }, 0);
        return this;
      });

      await expect(sftpList(ip, '/root')).rejects.toThrow('Connection failed');
    });
  });

  describe('sftpRead', () => {
    it('reads a file if within size limits', async () => {
      const ip = '203.0.113.21';
      mockSftp.stat.mockImplementation((_path: string, cb: (err: Error | null, stats: { size: number }) => void) => {
        cb(null, { size: 1024 }); // 1KB
      });
      mockSftp.readFile.mockImplementation((_path: string, _encoding: string, cb: (err: Error | null, data: Buffer) => void) => {
        cb(null, Buffer.from('hello world'));
      });

      const result = await sftpRead(ip, '/root/test.txt');
      expect(result).toBe('hello world');
      expect(resolveSshConnectConfig).toHaveBeenCalledWith(ip, 15_000);
    });

    it('rejects if file exceeds 2MB limit', async () => {
      const ip = '203.0.113.22';
      mockSftp.stat.mockImplementation((_path: string, cb: (err: Error | null, stats: { size: number }) => void) => {
        cb(null, { size: 3 * 1024 * 1024 }); // 3MB
      });

      await expect(sftpRead(ip, '/root/large.log')).rejects.toThrow('File too large to read in browser (max 2MB)');
      expect(mockSftp.readFile).not.toHaveBeenCalled();
    });
  });

  describe('sftpRealpath', () => {
    it('resolves the canonical remote path', async () => {
      const ip = '203.0.113.23';
      mockSftp.realpath.mockImplementation((targetPath: string, cb: (err: Error | null, resolvedPath: string) => void) => {
        cb(null, `/resolved${targetPath}`);
      });

      await expect(sftpRealpath(ip, '/root/link')).resolves.toBe('/resolved/root/link');
      expect(resolveSshConnectConfig).toHaveBeenCalledWith(ip, 15_000);
    });
  });

  describe('sftpReadBinary', () => {
    it('reads a binary file if within size limits', async () => {
      const ip = '203.0.113.31';
      mockSftp.stat.mockImplementation((_path: string, cb: (err: Error | null, stats: { size: number }) => void) => {
        cb(null, { size: 2048 });
      });
      mockSftp.readFile.mockImplementation((_path: string, cb: (err: Error | null, data: Buffer) => void) => {
        cb(null, Buffer.from([0x25, 0x50, 0x44, 0x46]));
      });

      const result = await sftpReadBinary(ip, '/root/manual.pdf', 4096);
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.equals(Buffer.from([0x25, 0x50, 0x44, 0x46]))).toBe(true);
      expect(resolveSshConnectConfig).toHaveBeenCalledWith(ip, 15_000);
    });

    it('rejects if binary preview exceeds the configured size limit', async () => {
      const ip = '203.0.113.32';
      mockSftp.stat.mockImplementation((_path: string, cb: (err: Error | null, stats: { size: number }) => void) => {
        cb(null, { size: 10 * 1024 * 1024 });
      });

      await expect(sftpReadBinary(ip, '/root/huge.pdf', 4 * 1024 * 1024)).rejects.toThrow(
        'File too large to preview in browser (max 4.0 MB)'
      );
      expect(mockSftp.readFile).not.toHaveBeenCalled();
    });
  });

  describe('sftpWrite', () => {
    it('writes a file successfully', async () => {
      const ip = '203.0.113.41';
      mockSftp.writeFile.mockImplementation((_path: string, _content: string, _encoding: string, cb: (err: Error | null) => void) => {
        cb(null);
      });

      await expect(sftpWrite(ip, '/root/save.txt', 'hello')).resolves.toBeUndefined();
      expect(mockSftp.writeFile).toHaveBeenCalledWith('/root/save.txt', 'hello', 'utf8', expect.any(Function));
      expect(resolveSshConnectConfig).toHaveBeenCalledWith(ip, 15_000);
    });

    it('reuses the same SSH connection for sequential operations against one host', async () => {
      const ip = '203.0.113.51';

      mockSftp.readdir.mockImplementation((_path: string, cb: (err: Error | null, list: unknown[]) => void) => {
        cb(null, [
          { filename: 'config.json', attrs: { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, size: 10, mtime: 123 } },
        ]);
      });
      mockSftp.stat.mockImplementation((_path: string, cb: (err: Error | null, stats: { size: number }) => void) => {
        cb(null, { size: 128 });
      });
      mockSftp.readFile.mockImplementation((_path: string, encodingOrCb: string | ((err: Error | null, data: Buffer) => void), cb?: (err: Error | null, data: Buffer) => void) => {
        const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb!;
        callback(null, Buffer.from('{"ok":true}'));
      });

      const files = await sftpList(ip, '/root');
      const content = await sftpRead(ip, '/root/config.json');

      expect(files).toHaveLength(1);
      expect(content).toBe('{"ok":true}');
      expect(Client).toHaveBeenCalledTimes(1);
      expect(resolveSshConnectConfig).toHaveBeenCalledTimes(1);
      expect(resolveSshConnectConfig).toHaveBeenCalledWith(ip, 15_000);
    });
  });
});
