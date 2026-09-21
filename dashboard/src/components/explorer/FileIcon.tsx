import { 
  Folder, File, FileText, Code, FileJson, 
  Image as ImageIcon, Terminal, FileCode2,
  Database, Package, FileVideo, Archive
} from 'lucide-react';

interface FileIconProps {
  type: 'file' | 'directory' | 'symlink' | 'other';
  name: string;
  size?: number;
  className?: string;
}

export function FileIcon({ type, name, size = 24, className = "" }: FileIconProps) {
  if (type === 'directory') {
    return <Folder size={size} className={`text-blue-400 fill-blue-400/20 ${className}`} />;
  }

  const ext = name.split('.').pop()?.toLowerCase();

  switch (ext) {
    case 'json':
      return <FileJson size={size} className={`text-yellow-400 ${className}`} />;
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
      return <FileCode2 size={size} className={`text-blue-300 ${className}`} />;
    case 'py':
      return <Code size={size} className={`text-green-400 ${className}`} />;
    case 'md':
    case 'txt':
    case 'csv':
      return <FileText size={size} className={`text-slate-300 ${className}`} />;
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':
      return <ImageIcon size={size} className={`text-purple-400 ${className}`} />;
    case 'mp4':
    case 'webm':
      return <FileVideo size={size} className={`text-purple-500 ${className}`} />;
    case 'zip':
    case 'tar':
    case 'gz':
      return <Archive size={size} className={`text-red-400 ${className}`} />;
    case 'sh':
    case 'bash':
    case 'zsh':
      return <Terminal size={size} className={`text-emerald-400 ${className}`} />;
    case 'db':
    case 'sqlite':
    case 'sqlite3':
      return <Database size={size} className={`text-slate-400 ${className}`} />;
    case 'jsonc':
    case 'lock':
      return <Package size={size} className={`text-orange-400 ${className}`} />;
    default:
      return <File size={size} className={`text-slate-400 ${className}`} />;
  }
}
