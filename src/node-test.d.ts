/**
 * node:test / node:assert 的最小类型声明。
 * 项目没有 @types/node（前端项目装它没必要），单测在 node 下经 tsc 发射后运行，
 * 这份声明让 tsc 认得这两个模块，不用为测试引入整套 Node 类型。
 */
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string | Error): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string | Error): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  export function deepStrictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  export function strictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  export function match(string: string, regexp: RegExp, message?: string | Error): void;
  export function throws(fn: () => unknown, message?: string | Error): void;
}
