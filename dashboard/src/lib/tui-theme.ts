export type HermesTuiColorMode = 'dark' | 'light';

type HermesXtermTheme = {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

export interface HermesTuiTheme {
  colorMode: HermesTuiColorMode;
  workspace: {
    loadingBackground: string;
    loadingAccent: string;
    pageBackground: string;
    panelBackground: string;
    panelBackgroundAlt: string;
    terminalCardBackground: string;
    utilityRailBackground: string;
    shadow: string;
    overlayShadow: string;
    border: string;
    borderSoft: string;
    buttonBorder: string;
    textPrimary: string;
    textSecondary: string;
    textMuted: string;
    textSubtle: string;
    labelAccent: string;
    buttonBackground: string;
    buttonBackgroundActive: string;
    buttonText: string;
    iconButtonBackground: string;
    iconButtonText: string;
    featureSuccess: string;
    featureAccent: string;
    featureInfo: string;
    featureWave: string;
  };
  terminal: {
    frameBackground: string;
    headerBackground: string;
    headerBorder: string;
    headerText: string;
    headerMutedText: string;
    metaChipBackground: string;
    metaChipBorder: string;
    metaChipText: string;
    metaChipAccentBackground: string;
    metaChipAccentBorder: string;
    metaChipAccentText: string;
    reconnectBackground: string;
    reconnectBackgroundHover: string;
    reconnectBorder: string;
    reconnectText: string;
    inputHintBackground: string;
    inputHintBorder: string;
    inputHintText: string;
    inputHintCursor: string;
    inputHintShadow: string;
    xterm: HermesXtermTheme;
  };
  status: {
    init: string;
    connecting: string;
    connected: string;
    error: string;
    closed: string;
  };
}

const DARK_THEME: HermesTuiTheme = {
  colorMode: 'dark',
  workspace: {
    loadingBackground: 'radial-gradient(circle at top, rgba(44, 38, 72, 0.8), #06070d 62%)',
    loadingAccent: '#ff3a3b',
    pageBackground: 'radial-gradient(circle at top, rgba(38, 34, 64, 0.85), rgba(8, 8, 16, 1) 52%)',
    panelBackground: 'linear-gradient(180deg, rgba(16, 14, 24, 0.96) 0%, rgba(10, 10, 18, 0.98) 100%)',
    panelBackgroundAlt: 'linear-gradient(180deg, rgba(15, 14, 24, 0.96) 0%, rgba(9, 9, 16, 0.98) 100%)',
    terminalCardBackground: 'linear-gradient(180deg, rgba(12, 11, 20, 0.98) 0%, rgba(7, 7, 14, 0.98) 100%)',
    utilityRailBackground: 'linear-gradient(180deg, rgba(11, 10, 18, 0.98) 0%, rgba(7, 7, 14, 0.98) 100%)',
    shadow: '0 26px 80px rgba(0, 0, 0, 0.34)',
    overlayShadow: '-18px 0 48px rgba(0, 0, 0, 0.34)',
    border: 'rgba(255, 44, 45, 0.18)',
    borderSoft: 'rgba(255, 44, 45, 0.14)',
    buttonBorder: 'rgba(255, 44, 45, 0.28)',
    textPrimary: 'rgba(244, 238, 229, 0.96)',
    textSecondary: 'rgba(191, 183, 170, 0.78)',
    textMuted: 'rgba(191, 183, 170, 0.74)',
    textSubtle: 'rgba(191, 183, 170, 0.7)',
    labelAccent: '#ff3a3b',
    buttonBackground: 'rgba(255,255,255,0.02)',
    buttonBackgroundActive: 'rgba(255, 44, 45, 0.12)',
    buttonText: 'rgba(244, 238, 229, 0.92)',
    iconButtonBackground: 'rgba(255,255,255,0.02)',
    iconButtonText: 'rgba(244, 238, 229, 0.88)',
    featureSuccess: '#60d394',
    featureAccent: '#ff3a3b',
    featureInfo: '#7dd3fc',
    featureWave: '#c084fc',
  },
  terminal: {
    frameBackground: 'linear-gradient(180deg, #07080e 0%, #0b0d15 100%)',
    headerBackground: 'linear-gradient(180deg, rgba(15, 16, 24, 0.98) 0%, rgba(10, 11, 18, 0.98) 100%)',
    headerBorder: '#1a1a2e',
    headerText: 'rgba(240, 236, 229, 0.92)',
    headerMutedText: 'rgba(191, 183, 170, 0.72)',
    metaChipBackground: 'rgba(255, 255, 255, 0.03)',
    metaChipBorder: 'rgba(255, 44, 45, 0.16)',
    metaChipText: 'rgba(234, 228, 220, 0.82)',
    metaChipAccentBackground: 'rgba(255, 44, 45, 0.12)',
    metaChipAccentBorder: 'rgba(255, 44, 45, 0.24)',
    metaChipAccentText: '#f2de9a',
    reconnectBackground: 'rgba(124,106,247,0.12)',
    reconnectBackgroundHover: 'rgba(124,106,247,0.25)',
    reconnectBorder: 'rgba(124,106,247,0.3)',
    reconnectText: '#a78bfa',
    inputHintBackground: 'rgba(8, 8, 16, 0.88)',
    inputHintBorder: 'rgba(124,106,247,0.32)',
    inputHintText: '#d0ceff',
    inputHintCursor: '#7c6af7',
    inputHintShadow: '0 14px 40px rgba(0, 0, 0, 0.36)',
    xterm: {
      background: '#080810',
      foreground: '#d0ceff',
      cursor: '#7c6af7',
      cursorAccent: '#080810',
      selectionBackground: 'rgba(124,106,247,0.25)',
      black: '#1a1a2e',
      red: '#f87171',
      green: '#123f3c',
      yellow: '#fbbf24',
      blue: '#11163d',
      magenta: '#5b3f91',
      cyan: '#15424d',
      white: '#e9e8ff',
      brightBlack: '#3a3a5e',
      brightRed: '#fca5a5',
      brightGreen: '#4fd1b8',
      brightYellow: '#fde68a',
      brightBlue: '#8aa4ff',
      brightMagenta: '#c084fc',
      brightCyan: '#7dd3fc',
      brightWhite: '#f0f0ff',
    },
  },
  status: {
    init: '#555',
    connecting: '#fbbf24',
    connected: '#2dd4bf',
    error: '#f87171',
    closed: '#6b7280',
  },
};

const LIGHT_THEME: HermesTuiTheme = {
  colorMode: 'light',
  workspace: {
    loadingBackground: 'radial-gradient(circle at top, rgba(251, 244, 231, 0.98), rgba(232, 224, 212, 1) 66%)',
    loadingAccent: '#9a6c05',
    pageBackground: 'radial-gradient(circle at top, rgba(250, 242, 229, 0.98), rgba(236, 229, 217, 1) 58%)',
    panelBackground: 'linear-gradient(180deg, rgba(249, 244, 236, 0.98) 0%, rgba(236, 228, 215, 0.98) 100%)',
    panelBackgroundAlt: 'linear-gradient(180deg, rgba(246, 240, 231, 0.98) 0%, rgba(233, 223, 209, 0.98) 100%)',
    terminalCardBackground: 'linear-gradient(180deg, rgba(243, 234, 220, 0.98) 0%, rgba(229, 219, 205, 0.98) 100%)',
    utilityRailBackground: 'linear-gradient(180deg, rgba(247, 241, 233, 0.98) 0%, rgba(233, 223, 209, 0.98) 100%)',
    shadow: '0 22px 60px rgba(91, 74, 48, 0.14)',
    overlayShadow: '-18px 0 42px rgba(91, 74, 48, 0.12)',
    border: 'rgba(154, 108, 5, 0.2)',
    borderSoft: 'rgba(154, 108, 5, 0.14)',
    buttonBorder: 'rgba(154, 108, 5, 0.24)',
    textPrimary: 'rgba(37, 28, 16, 0.96)',
    textSecondary: 'rgba(75, 60, 41, 0.84)',
    textMuted: 'rgba(90, 73, 51, 0.76)',
    textSubtle: 'rgba(110, 91, 66, 0.72)',
    labelAccent: '#9a6c05',
    buttonBackground: 'rgba(255, 251, 243, 0.66)',
    buttonBackgroundActive: 'rgba(154, 108, 5, 0.1)',
    buttonText: 'rgba(37, 28, 16, 0.92)',
    iconButtonBackground: 'rgba(255, 251, 243, 0.7)',
    iconButtonText: 'rgba(37, 28, 16, 0.88)',
    featureSuccess: '#0f766e',
    featureAccent: '#9a6c05',
    featureInfo: '#0369a1',
    featureWave: '#9333ea',
  },
  terminal: {
    frameBackground: 'linear-gradient(180deg, #f2e8da 0%, #e7dbc9 100%)',
    headerBackground: 'linear-gradient(180deg, rgba(251, 246, 238, 0.98) 0%, rgba(236, 226, 210, 0.98) 100%)',
    headerBorder: '#cebda3',
    headerText: '#362817',
    headerMutedText: '#6a563f',
    metaChipBackground: 'rgba(255, 251, 243, 0.78)',
    metaChipBorder: 'rgba(122, 92, 38, 0.18)',
    metaChipText: '#5f4a35',
    metaChipAccentBackground: 'rgba(154, 108, 5, 0.1)',
    metaChipAccentBorder: 'rgba(154, 108, 5, 0.24)',
    metaChipAccentText: '#7c5700',
    reconnectBackground: 'rgba(154, 108, 5, 0.08)',
    reconnectBackgroundHover: 'rgba(154, 108, 5, 0.14)',
    reconnectBorder: 'rgba(154, 108, 5, 0.24)',
    reconnectText: '#9a6c05',
    inputHintBackground: 'rgba(252, 248, 241, 0.96)',
    inputHintBorder: 'rgba(122, 92, 38, 0.24)',
    inputHintText: '#4b3b2b',
    inputHintCursor: '#9a6c05',
    inputHintShadow: '0 14px 36px rgba(91, 74, 48, 0.16)',
    xterm: {
      background: '#f2e8da',
      foreground: '#2c2116',
      cursor: '#8c5f0a',
      cursorAccent: '#f2e8da',
      selectionBackground: 'rgba(140,95,10,0.18)',
      black: '#2c2218',
      red: '#b6431a',
      green: '#d8eee8',
      yellow: '#8d5c00',
      blue: '#dbe7f8',
      magenta: '#e8ddf7',
      cyan: '#d9edf3',
      white: '#655746',
      brightBlack: '#7a6a58',
      brightRed: '#d55a24',
      brightGreen: '#0f766e',
      brightYellow: '#af7400',
      brightBlue: '#2563eb',
      brightMagenta: '#a15bee',
      brightCyan: '#0891b2',
      brightWhite: '#23190f',
    },
  },
  status: {
    init: '#8a7a66',
    connecting: '#b45309',
    connected: '#0f766e',
    error: '#c2410c',
    closed: '#7c6c58',
  },
};

export function resolveHermesTuiColorMode(resolvedTheme: string | null | undefined): HermesTuiColorMode {
  return resolvedTheme === 'light' ? 'light' : 'dark';
}

export function getHermesTuiTheme(colorMode: HermesTuiColorMode): HermesTuiTheme {
  return colorMode === 'light' ? LIGHT_THEME : DARK_THEME;
}
