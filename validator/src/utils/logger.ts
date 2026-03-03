import winston from 'winston';

export function createLogger(component: string): winston.Logger {
  return winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
    defaultMeta: { component, nodeId: process.env.VALIDATOR_NODE_ID },
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, component, ...rest }) => {
            const extra = Object.keys(rest).length > 0
              ? ` ${JSON.stringify(rest)}`
              : '';
            return `${timestamp} [${component}] ${level}: ${message}${extra}`;
          })
        ),
      }),
      new winston.transports.File({
        filename: 'logs/validator-error.log',
        level: 'error',
        maxsize: 50 * 1024 * 1024, // 50MB
        maxFiles: 10,
      }),
      new winston.transports.File({
        filename: 'logs/validator.log',
        maxsize: 100 * 1024 * 1024, // 100MB
        maxFiles: 20,
      }),
    ],
  });
}
