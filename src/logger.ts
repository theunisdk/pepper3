import pino from 'pino';

/**
 * Everything the model does — tool calls, reasoning, command output — is logged
 * here and nowhere else. It must never reach Telegram; that separation is what
 * makes "no debug output in chat" structural rather than aspirational.
 */
export const logger = pino({
  level: process.env.PEPPER_LOG_LEVEL ?? 'info',
  // On EC2 stdout is journald, which timestamps for us.
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ['token', '*.token', 'botToken', '*.botToken', 'access_token', '*.access_token'],
    censor: '[redacted]',
  },
});

export type Logger = typeof logger;
