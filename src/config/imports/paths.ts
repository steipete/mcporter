import os from 'node:os';
import path from 'node:path';
import type { ImportKind } from '../../config-schema.js';

export function pathsForImport(kind: ImportKind, rootDir: string): string[] {
  switch (kind) {
    case 'cursor':
      return dedupePaths([
        path.resolve(rootDir, '.cursor', 'mcp.json'),
        path.join(os.homedir(), '.cursor', 'mcp.json'),
        ...defaultCursorUserConfigPaths(),
      ]);
    case 'claude-code':
      return dedupePaths([
        path.resolve(rootDir, '.claude', 'settings.local.json'),
        path.resolve(rootDir, '.claude', 'settings.json'),
        path.resolve(rootDir, '.claude', 'mcp.json'),
        path.join(os.homedir(), '.claude', 'settings.local.json'),
        path.join(os.homedir(), '.claude', 'settings.json'),
        path.join(os.homedir(), '.claude', 'mcp.json'),
        path.join(os.homedir(), '.claude.json'),
      ]);
    case 'claude-desktop':
      return [defaultClaudeDesktopConfigPath()];
    case 'codex':
      return [path.resolve(rootDir, '.codex', 'config.toml'), path.join(os.homedir(), '.codex', 'config.toml')];
    case 'windsurf':
      return defaultWindsurfConfigPaths();
    case 'opencode':
      return opencodeConfigPaths(rootDir);
    case 'vscode':
      return dedupePaths([path.resolve(rootDir, '.vscode', 'mcp.json'), ...defaultVscodeConfigPaths()]);
    default:
      return [];
  }
}

function defaultCursorUserConfigPaths(): string[] {
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  const configs = xdgConfig ? [path.join(xdgConfig, 'Cursor', 'User', 'mcp.json')] : [];
  return dedupePaths([
    path.join(os.homedir(), 'AppData', 'Roaming', 'Cursor', 'User', 'mcp.json'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'mcp.json'),
    ...configs,
  ]);
}

function defaultWindsurfConfigPaths(): string[] {
  const homeDir = os.homedir();
  const paths = [
    path.join(homeDir, '.codeium', 'windsurf', 'mcp_config.json'),
    path.join(homeDir, '.codeium', 'windsurf-next', 'mcp_config.json'),
    path.join(homeDir, '.windsurf', 'mcp_config.json'),
    path.join(homeDir, '.config', '.codeium', 'windsurf', 'mcp_config.json'),
  ];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(homeDir, 'AppData', 'Roaming');
    paths.push(path.join(appData, 'Codeium', 'windsurf', 'mcp_config.json'));
  }
  return dedupePaths(paths);
}

function defaultVscodeConfigPaths(): string[] {
  if (process.platform === 'darwin') {
    return [
      path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
      path.join(os.homedir(), 'Library', 'Application Support', 'Code - Insiders', 'User', 'mcp.json'),
    ];
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return [path.join(appData, 'Code', 'User', 'mcp.json'), path.join(appData, 'Code - Insiders', 'User', 'mcp.json')];
  }
  return [
    path.join(os.homedir(), '.config', 'Code', 'User', 'mcp.json'),
    path.join(os.homedir(), '.config', 'Code - Insiders', 'User', 'mcp.json'),
  ];
}

function opencodeConfigPaths(rootDir: string): string[] {
  const overrideConfig = process.env.OPENCODE_CONFIG;
  const overrideDir = process.env.OPENCODE_CONFIG_DIR;
  const envConfigPath = process.env.OPENAI_WORKDIR;
  const xdg = process.env.XDG_CONFIG_HOME;
  const configHome = xdg ?? path.join(process.env.HOME ?? '', '.config');
  const paths: string[] = [
    overrideConfig ?? '',
    path.resolve(rootDir, 'opencode.jsonc'),
    path.resolve(rootDir, 'opencode.json'),
  ];
  if (overrideDir && overrideDir.length > 0) {
    paths.push(path.join(overrideDir, 'opencode.jsonc'), path.join(overrideDir, 'opencode.json'));
  }
  paths.push(
    path.resolve(rootDir, '.openai', 'config.json'),
    envConfigPath ? path.resolve(envConfigPath, '.openai', 'config.json') : '',
    path.join(configHome, 'openai', 'config.json')
  );
  for (const dir of defaultOpencodeConfigDirs()) {
    paths.push(path.join(dir, 'opencode.jsonc'), path.join(dir, 'opencode.json'));
  }
  return dedupePaths(paths);
}

function defaultOpencodeConfigDirs(): string[] {
  const dirs: string[] = [];
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) {
    dirs.push(path.join(xdg, 'opencode'));
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    dirs.push(path.join(appData, 'opencode'));
  } else {
    dirs.push(path.join(os.homedir(), '.config', 'opencode'));
  }
  return dirs;
}

function defaultClaudeDesktopConfigPath(): string {
  const homeDir = os.homedir();
  const darwinPath = path.join(homeDir, 'Library', 'Application Support', 'Claude', 'settings.json');
  const windowsPath = path.join(homeDir, 'AppData', 'Roaming', 'Claude', 'settings.json');
  const linuxPath = path.join(homeDir, '.config', 'Claude', 'settings.json');
  const platform = process.platform;
  if (platform === 'darwin') {
    return darwinPath;
  }
  if (platform === 'win32') {
    return windowsPath;
  }
  return linuxPath;
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of paths) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    result.push(candidate);
  }
  return result;
}
