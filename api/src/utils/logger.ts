import winston from 'winston';

export function createLogger(component: string): winston.Logger {
  return winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
    defaultMeta: { component, service: 'bridge-api' },
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, component, ...rest }) => {
            const extra = Object.keys(rest).length > 1
              ? ` ${JSON.stringify(rest)}`
              : '';
            return `${timestamp} [${component}] ${level}: ${message}${extra}`;
          })
        ),
      }),
      new winston.transports.File({
        filename: 'logs/api-error.log',
        level: 'error',
      }),
      new winston.transports.File({
        filename: 'logs/api.log',
      }),
    ],
  });
}
