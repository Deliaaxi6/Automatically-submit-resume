import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { PuppeteerExtraPlugin } = require('puppeteer-extra-plugin')

const stealthScript = () => {
  "use strict";

  const nativeFunctionToString = Function.prototype.toString;

  const nativeSourceMap = new WeakMap();

  const registerNativeSource = (fn, source) => {
    try {
      nativeSourceMap.set(fn, source);
    } catch (_) {}
  };

  Object.defineProperty(Function.prototype, "toString", {
    configurable: true,
    writable: true,
    value: function toString() {
      if (nativeSourceMap.has(this)) {
        return nativeSourceMap.get(this);
      }
      return nativeFunctionToString.call(this);
    },
  });

  registerNativeSource(
    Function.prototype.toString,
    nativeFunctionToString.toString(),
  );

  const stealthify = (obj, prop, handler) => {
    const original = obj[prop];
    if (typeof original !== "function") return;

    const wrapped = function (...args) {
      return handler.call(this, original, args);
    };
    const namePropertyDescriptor = Object.getOwnPropertyDescriptor(
      wrapped,
      "name",
    );
    Object.defineProperty(wrapped, "name", {
      ...namePropertyDescriptor,
      value: prop,
    });
    try {
      Object.setPrototypeOf(wrapped, Object.getPrototypeOf(original));
    } catch (_) {}

    registerNativeSource(wrapped, nativeFunctionToString.call(original));

    const desc = Object.getOwnPropertyDescriptor(obj, prop);
    Object.defineProperty(obj, prop, {
      ...desc,
      value: wrapped,
    });
  };

  const filterConsoleArgs = (args) =>
    args.map((arg) => {
      if (arg && typeof arg === "object") {
        return {};
      }
      return arg;
    });

  [
    "log",
    "debug",
    "info",
    "warn",
    "error",
    "dir",
    "table",
  ].forEach((name) => {
    stealthify(console, name, (original, args) => {
      return original.apply(console, filterConsoleArgs(args));
    });
  });

  registerNativeSource(
    registerNativeSource,
    "function registerNativeSource() { [native code] }",
  );
};

async function handle(p) {
  try {
    await p.evaluate(stealthScript);
  } catch (e) {
  }
  await p.evaluateOnNewDocument(stealthScript);
}

class Plugin extends PuppeteerExtraPlugin {
  constructor() {
    super();
  }

  get name() {
    return "laodeng";
  }

  async onBrowser(browser) {
    const pages = await browser.pages();
    for (const p of pages) {
      await handle(p);
    }
  }

  async onPageCreated(p) {
    await handle(p);
  }
}

export default function (pluginConfig) {
  return new Plugin(pluginConfig);
}
