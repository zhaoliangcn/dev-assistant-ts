import pino, { type Logger as PinoLogger, type LoggerOptions } from 'pino'

/**
 * 结构化日志（pino）。
 * - TTY 环境用 pino-pretty 彩色输出
 * - 非 TTY（CI / 管道 / 后台）输出 JSON
 * - `--verbose` 提升到 debug 级别
 *
 * 对外暴露 AppLogger（msg 在前的简单签名），内部包装 pino 实例，
 * 避免各处代码直接依赖 pino 的重载签名。
 */

export interface AppLogger {
  debug(msg: string, obj?: object): void
  info(msg: string, obj?: object): void
  warn(msg: string, obj?: object): void
  error(msg: string, obj?: object): void
}

function createPino(verbose: boolean): PinoLogger {
  const options: LoggerOptions = {
    level: verbose ? 'debug' : 'info',
    base: undefined, // 不输出 pid/hostname
  }
  if (process.stdout.isTTY && !process.env.NO_COLOR) {
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname',
      },
    }
  }
  return pino(options)
}

function wrap(p: PinoLogger): AppLogger {
  const call =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (msg: string, obj?: object): void => {
      if (obj === undefined) {
        p[level](msg)
      } else {
        p[level](obj, msg)
      }
    }
  return {
    debug: call('debug'),
    info: call('info'),
    warn: call('warn'),
    error: call('error'),
  }
}

let pinoInstance: PinoLogger = createPino(false)

/** 全局 logger 绑定（configureLogger 重新赋值后，import 方可见新值 —— ESM live binding） */
export let log: AppLogger = wrap(pinoInstance)

/** 按 verbose 开关重建 logger */
export function configureLogger(verbose: boolean): void {
  pinoInstance = createPino(verbose)
  log = wrap(pinoInstance)
}

/** 调整日志级别（运行期热切换） */
export function setLogLevel(level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent'): void {
  pinoInstance.level = level
}
