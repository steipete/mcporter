import type { OutputFormat } from './output-utils.js';

interface ConsumeOutputOptions {
  defaultFormat?: OutputFormat;
  allowed?: OutputFormat[];
  enableRawShortcut?: boolean;
  jsonShortcutFlag?: string;
}

export function consumeOutputFormat(args: string[], options: ConsumeOutputOptions = {}): OutputFormat {
  const allowed = options.allowed ?? ['auto', 'text', 'markdown', 'json', 'raw'];
  const defaultFormat = options.defaultFormat ?? 'auto';
  const enableRawShortcut = options.enableRawShortcut !== false;
  let format: OutputFormat = defaultFormat;

  const isAllowed = (value: OutputFormat): boolean => allowed.includes(value);

  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === '--output') {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Flag '--output' requires a value.");
      }
      if (!isCliOutputFormat(value)) {
        throw new Error('--output format must be one of: auto, text, markdown, json, raw.');
      }
      if (!isAllowed(value)) {
        throw new Error(`--output format '${value}' is not supported for this command.`);
      }
      format = value;
      args.splice(index, 2);
      continue;
    }
    if (enableRawShortcut && token === '--raw') {
      if (!isAllowed('raw')) {
        throw new Error('--raw is not supported for this command.');
      }
      format = 'raw';
      args.splice(index, 1);
      continue;
    }
    if (options.jsonShortcutFlag && token === options.jsonShortcutFlag) {
      if (!isAllowed('json')) {
        throw new Error(`${options.jsonShortcutFlag} is not supported for this command.`);
      }
      format = 'json';
      args.splice(index, 1);
      continue;
    }
    index += 1;
  }

  if (!isAllowed(format)) {
    throw new Error(`Format '${format}' is not supported for this command.`);
  }
  return format;
}

export function isCliOutputFormat(value: string): value is OutputFormat {
  return value === 'auto' || value === 'text' || value === 'markdown' || value === 'json' || value === 'raw';
}
