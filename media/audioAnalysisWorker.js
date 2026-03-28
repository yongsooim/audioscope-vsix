"use strict";
(() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));
  var __toBinary = Uint8Array.fromBase64 || /* @__PURE__ */ (() => {
    var table = new Uint8Array(128);
    for (var i = 0; i < 64; i++) table[i < 26 ? i + 65 : i < 52 ? i + 71 : i < 62 ? i - 4 : i * 4 - 205] = i;
    return (base64) => {
      var n = base64.length, bytes = new Uint8Array((n - (base64[n - 1] == "=") - (base64[n - 2] == "=")) * 3 / 4 | 0);
      for (var i2 = 0, j = 0; i2 < n; ) {
        var c0 = table[base64.charCodeAt(i2++)], c1 = table[base64.charCodeAt(i2++)];
        var c2 = table[base64.charCodeAt(i2++)], c3 = table[base64.charCodeAt(i2++)];
        bytes[j++] = c0 << 2 | c1 >> 4;
        bytes[j++] = c1 << 4 | c2 >> 2;
        bytes[j++] = c2 << 6 | c3;
      }
      return bytes;
    };
  })();

  // node_modules/@echogarden/pffft-wasm/dist/non-simd/pffft.js
  var import_meta = {};
  var PFFFT = (() => {
    var _scriptName = import_meta.url;
    return (async function(moduleArg = {}) {
      var moduleRtn;
      var Module = moduleArg;
      var readyPromiseResolve, readyPromiseReject;
      var readyPromise = new Promise((resolve, reject) => {
        readyPromiseResolve = resolve;
        readyPromiseReject = reject;
      });
      var ENVIRONMENT_IS_WEB = typeof window == "object";
      var ENVIRONMENT_IS_WORKER = typeof importScripts == "function";
      var ENVIRONMENT_IS_NODE = typeof process == "object" && typeof process.versions == "object" && typeof process.versions.node == "string" && process.type != "renderer";
      if (ENVIRONMENT_IS_NODE) {
        const { createRequire } = await import("module");
        let dirname = import_meta.url;
        if (dirname.startsWith("data:")) {
          dirname = "/";
        }
        var require2 = createRequire(dirname);
      }
      var moduleOverrides = Object.assign({}, Module);
      var arguments_ = [];
      var thisProgram = "./this.program";
      var quit_ = (status, toThrow) => {
        throw toThrow;
      };
      var scriptDirectory = "";
      function locateFile(path) {
        if (Module["locateFile"]) {
          return Module["locateFile"](path, scriptDirectory);
        }
        return scriptDirectory + path;
      }
      var readAsync, readBinary;
      if (ENVIRONMENT_IS_NODE) {
        var fs = require2("fs");
        var nodePath = require2("path");
        if (!import_meta.url.startsWith("data:")) {
          scriptDirectory = nodePath.dirname(require2("url").fileURLToPath(import_meta.url)) + "/";
        }
        readBinary = (filename) => {
          filename = isFileURI(filename) ? new URL(filename) : nodePath.normalize(filename);
          var ret = fs.readFileSync(filename);
          return ret;
        };
        readAsync = (filename, binary = true) => {
          filename = isFileURI(filename) ? new URL(filename) : nodePath.normalize(filename);
          return new Promise((resolve, reject) => {
            fs.readFile(filename, binary ? void 0 : "utf8", (err2, data) => {
              if (err2) reject(err2);
              else resolve(binary ? data.buffer : data);
            });
          });
        };
        if (!Module["thisProgram"] && process.argv.length > 1) {
          thisProgram = process.argv[1].replace(/\\/g, "/");
        }
        arguments_ = process.argv.slice(2);
        quit_ = (status, toThrow) => {
          process.exitCode = status;
          throw toThrow;
        };
      } else if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
        if (ENVIRONMENT_IS_WORKER) {
          scriptDirectory = self.location.href;
        } else if (typeof document != "undefined" && document.currentScript) {
          scriptDirectory = document.currentScript.src;
        }
        if (_scriptName) {
          scriptDirectory = _scriptName;
        }
        if (scriptDirectory.startsWith("blob:")) {
          scriptDirectory = "";
        } else {
          scriptDirectory = scriptDirectory.substr(0, scriptDirectory.replace(/[?#].*/, "").lastIndexOf("/") + 1);
        }
        {
          if (ENVIRONMENT_IS_WORKER) {
            readBinary = (url) => {
              var xhr = new XMLHttpRequest();
              xhr.open("GET", url, false);
              xhr.responseType = "arraybuffer";
              xhr.send(null);
              return new Uint8Array(xhr.response);
            };
          }
          readAsync = (url) => {
            if (isFileURI(url)) {
              return new Promise((resolve, reject) => {
                var xhr = new XMLHttpRequest();
                xhr.open("GET", url, true);
                xhr.responseType = "arraybuffer";
                xhr.onload = () => {
                  if (xhr.status == 200 || xhr.status == 0 && xhr.response) {
                    resolve(xhr.response);
                    return;
                  }
                  reject(xhr.status);
                };
                xhr.onerror = reject;
                xhr.send(null);
              });
            }
            return fetch(url, { credentials: "same-origin" }).then((response) => {
              if (response.ok) {
                return response.arrayBuffer();
              }
              return Promise.reject(new Error(response.status + " : " + response.url));
            });
          };
        }
      } else {
      }
      var out = Module["print"] || console.log.bind(console);
      var err = Module["printErr"] || console.error.bind(console);
      Object.assign(Module, moduleOverrides);
      moduleOverrides = null;
      if (Module["arguments"]) arguments_ = Module["arguments"];
      if (Module["thisProgram"]) thisProgram = Module["thisProgram"];
      var wasmBinary = Module["wasmBinary"];
      var wasmMemory;
      var ABORT = false;
      var HEAP8, HEAPU8, HEAP16, HEAPU16, HEAP32, HEAPU32, HEAPF32, HEAPF64;
      function updateMemoryViews() {
        var b = wasmMemory.buffer;
        Module["HEAP8"] = HEAP8 = new Int8Array(b);
        Module["HEAP16"] = HEAP16 = new Int16Array(b);
        Module["HEAPU8"] = HEAPU8 = new Uint8Array(b);
        Module["HEAPU16"] = HEAPU16 = new Uint16Array(b);
        Module["HEAP32"] = HEAP32 = new Int32Array(b);
        Module["HEAPU32"] = HEAPU32 = new Uint32Array(b);
        Module["HEAPF32"] = HEAPF32 = new Float32Array(b);
        Module["HEAPF64"] = HEAPF64 = new Float64Array(b);
      }
      var __ATPRERUN__ = [];
      var __ATINIT__ = [];
      var __ATPOSTRUN__ = [];
      var runtimeInitialized = false;
      function preRun() {
        var preRuns = Module["preRun"];
        if (preRuns) {
          if (typeof preRuns == "function") preRuns = [preRuns];
          preRuns.forEach(addOnPreRun);
        }
        callRuntimeCallbacks(__ATPRERUN__);
      }
      function initRuntime() {
        runtimeInitialized = true;
        callRuntimeCallbacks(__ATINIT__);
      }
      function postRun() {
        var postRuns = Module["postRun"];
        if (postRuns) {
          if (typeof postRuns == "function") postRuns = [postRuns];
          postRuns.forEach(addOnPostRun);
        }
        callRuntimeCallbacks(__ATPOSTRUN__);
      }
      function addOnPreRun(cb) {
        __ATPRERUN__.unshift(cb);
      }
      function addOnInit(cb) {
        __ATINIT__.unshift(cb);
      }
      function addOnPostRun(cb) {
        __ATPOSTRUN__.unshift(cb);
      }
      var runDependencies = 0;
      var runDependencyWatcher = null;
      var dependenciesFulfilled = null;
      function addRunDependency(id) {
        runDependencies++;
        Module["monitorRunDependencies"]?.(runDependencies);
      }
      function removeRunDependency(id) {
        runDependencies--;
        Module["monitorRunDependencies"]?.(runDependencies);
        if (runDependencies == 0) {
          if (runDependencyWatcher !== null) {
            clearInterval(runDependencyWatcher);
            runDependencyWatcher = null;
          }
          if (dependenciesFulfilled) {
            var callback = dependenciesFulfilled;
            dependenciesFulfilled = null;
            callback();
          }
        }
      }
      function abort(what) {
        Module["onAbort"]?.(what);
        what = "Aborted(" + what + ")";
        err(what);
        ABORT = true;
        what += ". Build with -sASSERTIONS for more info.";
        var e = new WebAssembly.RuntimeError(what);
        readyPromiseReject(e);
        throw e;
      }
      var dataURIPrefix = "data:application/octet-stream;base64,";
      var isDataURI = (filename) => filename.startsWith(dataURIPrefix);
      var isFileURI = (filename) => filename.startsWith("file://");
      function findWasmBinary() {
        if (Module["locateFile"]) {
          var f = "pffft.wasm";
          if (!isDataURI(f)) {
            return locateFile(f);
          }
          return f;
        }
        return new URL("pffft.wasm", import_meta.url).href;
      }
      var wasmBinaryFile;
      function getBinarySync(file) {
        if (file == wasmBinaryFile && wasmBinary) {
          return new Uint8Array(wasmBinary);
        }
        if (readBinary) {
          return readBinary(file);
        }
        throw "both async and sync fetching of the wasm failed";
      }
      function getBinaryPromise(binaryFile) {
        if (!wasmBinary) {
          return readAsync(binaryFile).then((response) => new Uint8Array(response), () => getBinarySync(binaryFile));
        }
        return Promise.resolve().then(() => getBinarySync(binaryFile));
      }
      function instantiateArrayBuffer(binaryFile, imports, receiver) {
        return getBinaryPromise(binaryFile).then((binary) => WebAssembly.instantiate(binary, imports)).then(receiver, (reason) => {
          err(`failed to asynchronously prepare wasm: ${reason}`);
          abort(reason);
        });
      }
      function instantiateAsync(binary, binaryFile, imports, callback) {
        if (!binary && typeof WebAssembly.instantiateStreaming == "function" && !isDataURI(binaryFile) && !isFileURI(binaryFile) && !ENVIRONMENT_IS_NODE && typeof fetch == "function") {
          return fetch(binaryFile, { credentials: "same-origin" }).then((response) => {
            var result = WebAssembly.instantiateStreaming(response, imports);
            return result.then(callback, function(reason) {
              err(`wasm streaming compile failed: ${reason}`);
              err("falling back to ArrayBuffer instantiation");
              return instantiateArrayBuffer(binaryFile, imports, callback);
            });
          });
        }
        return instantiateArrayBuffer(binaryFile, imports, callback);
      }
      function getWasmImports() {
        return { a: wasmImports };
      }
      function createWasm() {
        var info = getWasmImports();
        function receiveInstance(instance, module) {
          wasmExports = instance.exports;
          wasmMemory = wasmExports["d"];
          updateMemoryViews();
          addOnInit(wasmExports["e"]);
          removeRunDependency("wasm-instantiate");
          return wasmExports;
        }
        addRunDependency("wasm-instantiate");
        function receiveInstantiationResult(result) {
          receiveInstance(result["instance"]);
        }
        if (Module["instantiateWasm"]) {
          try {
            return Module["instantiateWasm"](info, receiveInstance);
          } catch (e) {
            err(`Module.instantiateWasm callback failed with error: ${e}`);
            readyPromiseReject(e);
          }
        }
        wasmBinaryFile ??= findWasmBinary();
        instantiateAsync(wasmBinary, wasmBinaryFile, info, receiveInstantiationResult).catch(readyPromiseReject);
        return {};
      }
      var callRuntimeCallbacks = (callbacks) => {
        callbacks.forEach((f) => f(Module));
      };
      function getValue(ptr, type = "i8") {
        if (type.endsWith("*")) type = "*";
        switch (type) {
          case "i1":
            return HEAP8[ptr];
          case "i8":
            return HEAP8[ptr];
          case "i16":
            return HEAP16[ptr >> 1];
          case "i32":
            return HEAP32[ptr >> 2];
          case "i64":
            abort("to do getValue(i64) use WASM_BIGINT");
          case "float":
            return HEAPF32[ptr >> 2];
          case "double":
            return HEAPF64[ptr >> 3];
          case "*":
            return HEAPU32[ptr >> 2];
          default:
            abort(`invalid type for getValue: ${type}`);
        }
      }
      var noExitRuntime = Module["noExitRuntime"] || true;
      function setValue(ptr, value, type = "i8") {
        if (type.endsWith("*")) type = "*";
        switch (type) {
          case "i1":
            HEAP8[ptr] = value;
            break;
          case "i8":
            HEAP8[ptr] = value;
            break;
          case "i16":
            HEAP16[ptr >> 1] = value;
            break;
          case "i32":
            HEAP32[ptr >> 2] = value;
            break;
          case "i64":
            abort("to do setValue(i64) use WASM_BIGINT");
          case "float":
            HEAPF32[ptr >> 2] = value;
            break;
          case "double":
            HEAPF64[ptr >> 3] = value;
            break;
          case "*":
            HEAPU32[ptr >> 2] = value;
            break;
          default:
            abort(`invalid type for setValue: ${type}`);
        }
      }
      var stackRestore = (val) => __emscripten_stack_restore(val);
      var stackSave = () => _emscripten_stack_get_current();
      var UTF8Decoder = typeof TextDecoder != "undefined" ? new TextDecoder() : void 0;
      var UTF8ArrayToString = (heapOrArray, idx = 0, maxBytesToRead = NaN) => {
        var endIdx = idx + maxBytesToRead;
        var endPtr = idx;
        while (heapOrArray[endPtr] && !(endPtr >= endIdx)) ++endPtr;
        if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) {
          return UTF8Decoder.decode(heapOrArray.subarray(idx, endPtr));
        }
        var str = "";
        while (idx < endPtr) {
          var u0 = heapOrArray[idx++];
          if (!(u0 & 128)) {
            str += String.fromCharCode(u0);
            continue;
          }
          var u1 = heapOrArray[idx++] & 63;
          if ((u0 & 224) == 192) {
            str += String.fromCharCode((u0 & 31) << 6 | u1);
            continue;
          }
          var u2 = heapOrArray[idx++] & 63;
          if ((u0 & 240) == 224) {
            u0 = (u0 & 15) << 12 | u1 << 6 | u2;
          } else {
            u0 = (u0 & 7) << 18 | u1 << 12 | u2 << 6 | heapOrArray[idx++] & 63;
          }
          if (u0 < 65536) {
            str += String.fromCharCode(u0);
          } else {
            var ch = u0 - 65536;
            str += String.fromCharCode(55296 | ch >> 10, 56320 | ch & 1023);
          }
        }
        return str;
      };
      var UTF8ToString = (ptr, maxBytesToRead) => ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead) : "";
      var ___assert_fail = (condition, filename, line, func) => {
        abort(`Assertion failed: ${UTF8ToString(condition)}, at: ` + [filename ? UTF8ToString(filename) : "unknown filename", line, func ? UTF8ToString(func) : "unknown function"]);
      };
      var __emscripten_memcpy_js = (dest, src, num) => HEAPU8.copyWithin(dest, src, src + num);
      var getHeapMax = () => 2147483648;
      var alignMemory = (size, alignment) => Math.ceil(size / alignment) * alignment;
      var growMemory = (size) => {
        var b = wasmMemory.buffer;
        var pages = (size - b.byteLength + 65535) / 65536 | 0;
        try {
          wasmMemory.grow(pages);
          updateMemoryViews();
          return 1;
        } catch (e) {
        }
      };
      var _emscripten_resize_heap = (requestedSize) => {
        var oldSize = HEAPU8.length;
        requestedSize >>>= 0;
        var maxHeapSize = getHeapMax();
        if (requestedSize > maxHeapSize) {
          return false;
        }
        for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
          var overGrownHeapSize = oldSize * (1 + 0.2 / cutDown);
          overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
          var newSize = Math.min(maxHeapSize, alignMemory(Math.max(requestedSize, overGrownHeapSize), 65536));
          var replacement = growMemory(newSize);
          if (replacement) {
            return true;
          }
        }
        return false;
      };
      var getCFunc = (ident) => {
        var func = Module["_" + ident];
        return func;
      };
      var writeArrayToMemory = (array, buffer) => {
        HEAP8.set(array, buffer);
      };
      var lengthBytesUTF8 = (str) => {
        var len = 0;
        for (var i = 0; i < str.length; ++i) {
          var c = str.charCodeAt(i);
          if (c <= 127) {
            len++;
          } else if (c <= 2047) {
            len += 2;
          } else if (c >= 55296 && c <= 57343) {
            len += 4;
            ++i;
          } else {
            len += 3;
          }
        }
        return len;
      };
      var stringToUTF8Array = (str, heap, outIdx, maxBytesToWrite) => {
        if (!(maxBytesToWrite > 0)) return 0;
        var startIdx = outIdx;
        var endIdx = outIdx + maxBytesToWrite - 1;
        for (var i = 0; i < str.length; ++i) {
          var u = str.charCodeAt(i);
          if (u >= 55296 && u <= 57343) {
            var u1 = str.charCodeAt(++i);
            u = 65536 + ((u & 1023) << 10) | u1 & 1023;
          }
          if (u <= 127) {
            if (outIdx >= endIdx) break;
            heap[outIdx++] = u;
          } else if (u <= 2047) {
            if (outIdx + 1 >= endIdx) break;
            heap[outIdx++] = 192 | u >> 6;
            heap[outIdx++] = 128 | u & 63;
          } else if (u <= 65535) {
            if (outIdx + 2 >= endIdx) break;
            heap[outIdx++] = 224 | u >> 12;
            heap[outIdx++] = 128 | u >> 6 & 63;
            heap[outIdx++] = 128 | u & 63;
          } else {
            if (outIdx + 3 >= endIdx) break;
            heap[outIdx++] = 240 | u >> 18;
            heap[outIdx++] = 128 | u >> 12 & 63;
            heap[outIdx++] = 128 | u >> 6 & 63;
            heap[outIdx++] = 128 | u & 63;
          }
        }
        heap[outIdx] = 0;
        return outIdx - startIdx;
      };
      var stringToUTF8 = (str, outPtr, maxBytesToWrite) => stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite);
      var stackAlloc = (sz) => __emscripten_stack_alloc(sz);
      var stringToUTF8OnStack = (str) => {
        var size = lengthBytesUTF8(str) + 1;
        var ret = stackAlloc(size);
        stringToUTF8(str, ret, size);
        return ret;
      };
      var ccall = (ident, returnType, argTypes, args, opts) => {
        var toC = { string: (str) => {
          var ret2 = 0;
          if (str !== null && str !== void 0 && str !== 0) {
            ret2 = stringToUTF8OnStack(str);
          }
          return ret2;
        }, array: (arr) => {
          var ret2 = stackAlloc(arr.length);
          writeArrayToMemory(arr, ret2);
          return ret2;
        } };
        function convertReturnValue(ret2) {
          if (returnType === "string") {
            return UTF8ToString(ret2);
          }
          if (returnType === "boolean") return Boolean(ret2);
          return ret2;
        }
        var func = getCFunc(ident);
        var cArgs = [];
        var stack = 0;
        if (args) {
          for (var i = 0; i < args.length; i++) {
            var converter = toC[argTypes[i]];
            if (converter) {
              if (stack === 0) stack = stackSave();
              cArgs[i] = converter(args[i]);
            } else {
              cArgs[i] = args[i];
            }
          }
        }
        var ret = func(...cArgs);
        function onDone(ret2) {
          if (stack !== 0) stackRestore(stack);
          return convertReturnValue(ret2);
        }
        ret = onDone(ret);
        return ret;
      };
      var cwrap = (ident, returnType, argTypes, opts) => {
        var numericArgs = !argTypes || argTypes.every((type) => type === "number" || type === "boolean");
        var numericRet = returnType !== "string";
        if (numericRet && numericArgs && !opts) {
          return getCFunc(ident);
        }
        return (...args) => ccall(ident, returnType, argTypes, args, opts);
      };
      var wasmImports = { a: ___assert_fail, c: __emscripten_memcpy_js, b: _emscripten_resize_heap };
      var wasmExports = createWasm();
      var ___wasm_call_ctors = () => (___wasm_call_ctors = wasmExports["e"])();
      var _pffft_aligned_malloc = Module["_pffft_aligned_malloc"] = (a0) => (_pffft_aligned_malloc = Module["_pffft_aligned_malloc"] = wasmExports["f"])(a0);
      var _malloc = Module["_malloc"] = (a0) => (_malloc = Module["_malloc"] = wasmExports["g"])(a0);
      var _pffft_aligned_free = Module["_pffft_aligned_free"] = (a0) => (_pffft_aligned_free = Module["_pffft_aligned_free"] = wasmExports["h"])(a0);
      var _free = Module["_free"] = (a0) => (_free = Module["_free"] = wasmExports["i"])(a0);
      var _pffft_simd_size = Module["_pffft_simd_size"] = () => (_pffft_simd_size = Module["_pffft_simd_size"] = wasmExports["j"])();
      var _pffft_new_setup = Module["_pffft_new_setup"] = (a0, a1) => (_pffft_new_setup = Module["_pffft_new_setup"] = wasmExports["k"])(a0, a1);
      var _pffft_destroy_setup = Module["_pffft_destroy_setup"] = (a0) => (_pffft_destroy_setup = Module["_pffft_destroy_setup"] = wasmExports["l"])(a0);
      var _pffft_zreorder = Module["_pffft_zreorder"] = (a0, a1, a2, a3) => (_pffft_zreorder = Module["_pffft_zreorder"] = wasmExports["m"])(a0, a1, a2, a3);
      var _pffft_zconvolve_accumulate = Module["_pffft_zconvolve_accumulate"] = (a0, a1, a2, a3, a4) => (_pffft_zconvolve_accumulate = Module["_pffft_zconvolve_accumulate"] = wasmExports["n"])(a0, a1, a2, a3, a4);
      var _pffft_transform = Module["_pffft_transform"] = (a0, a1, a2, a3, a4) => (_pffft_transform = Module["_pffft_transform"] = wasmExports["o"])(a0, a1, a2, a3, a4);
      var _pffft_transform_ordered = Module["_pffft_transform_ordered"] = (a0, a1, a2, a3, a4) => (_pffft_transform_ordered = Module["_pffft_transform_ordered"] = wasmExports["p"])(a0, a1, a2, a3, a4);
      var __emscripten_stack_restore = (a0) => (__emscripten_stack_restore = wasmExports["r"])(a0);
      var __emscripten_stack_alloc = (a0) => (__emscripten_stack_alloc = wasmExports["s"])(a0);
      var _emscripten_stack_get_current = () => (_emscripten_stack_get_current = wasmExports["t"])();
      Module["cwrap"] = cwrap;
      Module["setValue"] = setValue;
      Module["getValue"] = getValue;
      var calledRun;
      var calledPrerun;
      dependenciesFulfilled = function runCaller() {
        if (!calledRun) run();
        if (!calledRun) dependenciesFulfilled = runCaller;
      };
      function run() {
        if (runDependencies > 0) {
          return;
        }
        if (!calledPrerun) {
          calledPrerun = 1;
          preRun();
          if (runDependencies > 0) {
            return;
          }
        }
        function doRun() {
          if (calledRun) return;
          calledRun = 1;
          Module["calledRun"] = 1;
          if (ABORT) return;
          initRuntime();
          readyPromiseResolve(Module);
          Module["onRuntimeInitialized"]?.();
          postRun();
        }
        if (Module["setStatus"]) {
          Module["setStatus"]("Running...");
          setTimeout(() => {
            setTimeout(() => Module["setStatus"](""), 1);
            doRun();
          }, 1);
        } else {
          doRun();
        }
      }
      if (Module["preInit"]) {
        if (typeof Module["preInit"] == "function") Module["preInit"] = [Module["preInit"]];
        while (Module["preInit"].length > 0) {
          Module["preInit"].pop()();
        }
      }
      run();
      moduleRtn = readyPromise;
      return moduleRtn;
    });
  })();
  var pffft_default = PFFFT;

  // node_modules/@echogarden/pffft-wasm/dist/non-simd/pffft.wasm
  var pffft_default2 = __toBinary("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");

  // node_modules/@echogarden/pffft-wasm/dist/simd/pffft.js
  var import_meta2 = {};
  var PFFFT2 = (() => {
    var _scriptName = import_meta2.url;
    return (async function(moduleArg = {}) {
      var moduleRtn;
      var Module = moduleArg;
      var readyPromiseResolve, readyPromiseReject;
      var readyPromise = new Promise((resolve, reject) => {
        readyPromiseResolve = resolve;
        readyPromiseReject = reject;
      });
      var ENVIRONMENT_IS_WEB = typeof window == "object";
      var ENVIRONMENT_IS_WORKER = typeof importScripts == "function";
      var ENVIRONMENT_IS_NODE = typeof process == "object" && typeof process.versions == "object" && typeof process.versions.node == "string" && process.type != "renderer";
      if (ENVIRONMENT_IS_NODE) {
        const { createRequire } = await import("module");
        let dirname = import_meta2.url;
        if (dirname.startsWith("data:")) {
          dirname = "/";
        }
        var require2 = createRequire(dirname);
      }
      var moduleOverrides = Object.assign({}, Module);
      var arguments_ = [];
      var thisProgram = "./this.program";
      var quit_ = (status, toThrow) => {
        throw toThrow;
      };
      var scriptDirectory = "";
      function locateFile(path) {
        if (Module["locateFile"]) {
          return Module["locateFile"](path, scriptDirectory);
        }
        return scriptDirectory + path;
      }
      var readAsync, readBinary;
      if (ENVIRONMENT_IS_NODE) {
        var fs = require2("fs");
        var nodePath = require2("path");
        if (!import_meta2.url.startsWith("data:")) {
          scriptDirectory = nodePath.dirname(require2("url").fileURLToPath(import_meta2.url)) + "/";
        }
        readBinary = (filename) => {
          filename = isFileURI(filename) ? new URL(filename) : nodePath.normalize(filename);
          var ret = fs.readFileSync(filename);
          return ret;
        };
        readAsync = (filename, binary = true) => {
          filename = isFileURI(filename) ? new URL(filename) : nodePath.normalize(filename);
          return new Promise((resolve, reject) => {
            fs.readFile(filename, binary ? void 0 : "utf8", (err2, data) => {
              if (err2) reject(err2);
              else resolve(binary ? data.buffer : data);
            });
          });
        };
        if (!Module["thisProgram"] && process.argv.length > 1) {
          thisProgram = process.argv[1].replace(/\\/g, "/");
        }
        arguments_ = process.argv.slice(2);
        quit_ = (status, toThrow) => {
          process.exitCode = status;
          throw toThrow;
        };
      } else if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
        if (ENVIRONMENT_IS_WORKER) {
          scriptDirectory = self.location.href;
        } else if (typeof document != "undefined" && document.currentScript) {
          scriptDirectory = document.currentScript.src;
        }
        if (_scriptName) {
          scriptDirectory = _scriptName;
        }
        if (scriptDirectory.startsWith("blob:")) {
          scriptDirectory = "";
        } else {
          scriptDirectory = scriptDirectory.substr(0, scriptDirectory.replace(/[?#].*/, "").lastIndexOf("/") + 1);
        }
        {
          if (ENVIRONMENT_IS_WORKER) {
            readBinary = (url) => {
              var xhr = new XMLHttpRequest();
              xhr.open("GET", url, false);
              xhr.responseType = "arraybuffer";
              xhr.send(null);
              return new Uint8Array(xhr.response);
            };
          }
          readAsync = (url) => {
            if (isFileURI(url)) {
              return new Promise((resolve, reject) => {
                var xhr = new XMLHttpRequest();
                xhr.open("GET", url, true);
                xhr.responseType = "arraybuffer";
                xhr.onload = () => {
                  if (xhr.status == 200 || xhr.status == 0 && xhr.response) {
                    resolve(xhr.response);
                    return;
                  }
                  reject(xhr.status);
                };
                xhr.onerror = reject;
                xhr.send(null);
              });
            }
            return fetch(url, { credentials: "same-origin" }).then((response) => {
              if (response.ok) {
                return response.arrayBuffer();
              }
              return Promise.reject(new Error(response.status + " : " + response.url));
            });
          };
        }
      } else {
      }
      var out = Module["print"] || console.log.bind(console);
      var err = Module["printErr"] || console.error.bind(console);
      Object.assign(Module, moduleOverrides);
      moduleOverrides = null;
      if (Module["arguments"]) arguments_ = Module["arguments"];
      if (Module["thisProgram"]) thisProgram = Module["thisProgram"];
      var wasmBinary = Module["wasmBinary"];
      var wasmMemory;
      var ABORT = false;
      var HEAP8, HEAPU8, HEAP16, HEAPU16, HEAP32, HEAPU32, HEAPF32, HEAPF64;
      function updateMemoryViews() {
        var b = wasmMemory.buffer;
        Module["HEAP8"] = HEAP8 = new Int8Array(b);
        Module["HEAP16"] = HEAP16 = new Int16Array(b);
        Module["HEAPU8"] = HEAPU8 = new Uint8Array(b);
        Module["HEAPU16"] = HEAPU16 = new Uint16Array(b);
        Module["HEAP32"] = HEAP32 = new Int32Array(b);
        Module["HEAPU32"] = HEAPU32 = new Uint32Array(b);
        Module["HEAPF32"] = HEAPF32 = new Float32Array(b);
        Module["HEAPF64"] = HEAPF64 = new Float64Array(b);
      }
      var __ATPRERUN__ = [];
      var __ATINIT__ = [];
      var __ATPOSTRUN__ = [];
      var runtimeInitialized = false;
      function preRun() {
        var preRuns = Module["preRun"];
        if (preRuns) {
          if (typeof preRuns == "function") preRuns = [preRuns];
          preRuns.forEach(addOnPreRun);
        }
        callRuntimeCallbacks(__ATPRERUN__);
      }
      function initRuntime() {
        runtimeInitialized = true;
        callRuntimeCallbacks(__ATINIT__);
      }
      function postRun() {
        var postRuns = Module["postRun"];
        if (postRuns) {
          if (typeof postRuns == "function") postRuns = [postRuns];
          postRuns.forEach(addOnPostRun);
        }
        callRuntimeCallbacks(__ATPOSTRUN__);
      }
      function addOnPreRun(cb) {
        __ATPRERUN__.unshift(cb);
      }
      function addOnInit(cb) {
        __ATINIT__.unshift(cb);
      }
      function addOnPostRun(cb) {
        __ATPOSTRUN__.unshift(cb);
      }
      var runDependencies = 0;
      var runDependencyWatcher = null;
      var dependenciesFulfilled = null;
      function addRunDependency(id) {
        runDependencies++;
        Module["monitorRunDependencies"]?.(runDependencies);
      }
      function removeRunDependency(id) {
        runDependencies--;
        Module["monitorRunDependencies"]?.(runDependencies);
        if (runDependencies == 0) {
          if (runDependencyWatcher !== null) {
            clearInterval(runDependencyWatcher);
            runDependencyWatcher = null;
          }
          if (dependenciesFulfilled) {
            var callback = dependenciesFulfilled;
            dependenciesFulfilled = null;
            callback();
          }
        }
      }
      function abort(what) {
        Module["onAbort"]?.(what);
        what = "Aborted(" + what + ")";
        err(what);
        ABORT = true;
        what += ". Build with -sASSERTIONS for more info.";
        var e = new WebAssembly.RuntimeError(what);
        readyPromiseReject(e);
        throw e;
      }
      var dataURIPrefix = "data:application/octet-stream;base64,";
      var isDataURI = (filename) => filename.startsWith(dataURIPrefix);
      var isFileURI = (filename) => filename.startsWith("file://");
      function findWasmBinary() {
        if (Module["locateFile"]) {
          var f = "pffft.wasm";
          if (!isDataURI(f)) {
            return locateFile(f);
          }
          return f;
        }
        return new URL("pffft.wasm", import_meta2.url).href;
      }
      var wasmBinaryFile;
      function getBinarySync(file) {
        if (file == wasmBinaryFile && wasmBinary) {
          return new Uint8Array(wasmBinary);
        }
        if (readBinary) {
          return readBinary(file);
        }
        throw "both async and sync fetching of the wasm failed";
      }
      function getBinaryPromise(binaryFile) {
        if (!wasmBinary) {
          return readAsync(binaryFile).then((response) => new Uint8Array(response), () => getBinarySync(binaryFile));
        }
        return Promise.resolve().then(() => getBinarySync(binaryFile));
      }
      function instantiateArrayBuffer(binaryFile, imports, receiver) {
        return getBinaryPromise(binaryFile).then((binary) => WebAssembly.instantiate(binary, imports)).then(receiver, (reason) => {
          err(`failed to asynchronously prepare wasm: ${reason}`);
          abort(reason);
        });
      }
      function instantiateAsync(binary, binaryFile, imports, callback) {
        if (!binary && typeof WebAssembly.instantiateStreaming == "function" && !isDataURI(binaryFile) && !isFileURI(binaryFile) && !ENVIRONMENT_IS_NODE && typeof fetch == "function") {
          return fetch(binaryFile, { credentials: "same-origin" }).then((response) => {
            var result = WebAssembly.instantiateStreaming(response, imports);
            return result.then(callback, function(reason) {
              err(`wasm streaming compile failed: ${reason}`);
              err("falling back to ArrayBuffer instantiation");
              return instantiateArrayBuffer(binaryFile, imports, callback);
            });
          });
        }
        return instantiateArrayBuffer(binaryFile, imports, callback);
      }
      function getWasmImports() {
        return { a: wasmImports };
      }
      function createWasm() {
        var info = getWasmImports();
        function receiveInstance(instance, module) {
          wasmExports = instance.exports;
          wasmMemory = wasmExports["d"];
          updateMemoryViews();
          addOnInit(wasmExports["e"]);
          removeRunDependency("wasm-instantiate");
          return wasmExports;
        }
        addRunDependency("wasm-instantiate");
        function receiveInstantiationResult(result) {
          receiveInstance(result["instance"]);
        }
        if (Module["instantiateWasm"]) {
          try {
            return Module["instantiateWasm"](info, receiveInstance);
          } catch (e) {
            err(`Module.instantiateWasm callback failed with error: ${e}`);
            readyPromiseReject(e);
          }
        }
        wasmBinaryFile ??= findWasmBinary();
        instantiateAsync(wasmBinary, wasmBinaryFile, info, receiveInstantiationResult).catch(readyPromiseReject);
        return {};
      }
      var callRuntimeCallbacks = (callbacks) => {
        callbacks.forEach((f) => f(Module));
      };
      function getValue(ptr, type = "i8") {
        if (type.endsWith("*")) type = "*";
        switch (type) {
          case "i1":
            return HEAP8[ptr];
          case "i8":
            return HEAP8[ptr];
          case "i16":
            return HEAP16[ptr >> 1];
          case "i32":
            return HEAP32[ptr >> 2];
          case "i64":
            abort("to do getValue(i64) use WASM_BIGINT");
          case "float":
            return HEAPF32[ptr >> 2];
          case "double":
            return HEAPF64[ptr >> 3];
          case "*":
            return HEAPU32[ptr >> 2];
          default:
            abort(`invalid type for getValue: ${type}`);
        }
      }
      var noExitRuntime = Module["noExitRuntime"] || true;
      function setValue(ptr, value, type = "i8") {
        if (type.endsWith("*")) type = "*";
        switch (type) {
          case "i1":
            HEAP8[ptr] = value;
            break;
          case "i8":
            HEAP8[ptr] = value;
            break;
          case "i16":
            HEAP16[ptr >> 1] = value;
            break;
          case "i32":
            HEAP32[ptr >> 2] = value;
            break;
          case "i64":
            abort("to do setValue(i64) use WASM_BIGINT");
          case "float":
            HEAPF32[ptr >> 2] = value;
            break;
          case "double":
            HEAPF64[ptr >> 3] = value;
            break;
          case "*":
            HEAPU32[ptr >> 2] = value;
            break;
          default:
            abort(`invalid type for setValue: ${type}`);
        }
      }
      var stackRestore = (val) => __emscripten_stack_restore(val);
      var stackSave = () => _emscripten_stack_get_current();
      var UTF8Decoder = typeof TextDecoder != "undefined" ? new TextDecoder() : void 0;
      var UTF8ArrayToString = (heapOrArray, idx = 0, maxBytesToRead = NaN) => {
        var endIdx = idx + maxBytesToRead;
        var endPtr = idx;
        while (heapOrArray[endPtr] && !(endPtr >= endIdx)) ++endPtr;
        if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) {
          return UTF8Decoder.decode(heapOrArray.subarray(idx, endPtr));
        }
        var str = "";
        while (idx < endPtr) {
          var u0 = heapOrArray[idx++];
          if (!(u0 & 128)) {
            str += String.fromCharCode(u0);
            continue;
          }
          var u1 = heapOrArray[idx++] & 63;
          if ((u0 & 224) == 192) {
            str += String.fromCharCode((u0 & 31) << 6 | u1);
            continue;
          }
          var u2 = heapOrArray[idx++] & 63;
          if ((u0 & 240) == 224) {
            u0 = (u0 & 15) << 12 | u1 << 6 | u2;
          } else {
            u0 = (u0 & 7) << 18 | u1 << 12 | u2 << 6 | heapOrArray[idx++] & 63;
          }
          if (u0 < 65536) {
            str += String.fromCharCode(u0);
          } else {
            var ch = u0 - 65536;
            str += String.fromCharCode(55296 | ch >> 10, 56320 | ch & 1023);
          }
        }
        return str;
      };
      var UTF8ToString = (ptr, maxBytesToRead) => ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead) : "";
      var ___assert_fail = (condition, filename, line, func) => {
        abort(`Assertion failed: ${UTF8ToString(condition)}, at: ` + [filename ? UTF8ToString(filename) : "unknown filename", line, func ? UTF8ToString(func) : "unknown function"]);
      };
      var __emscripten_memcpy_js = (dest, src, num) => HEAPU8.copyWithin(dest, src, src + num);
      var getHeapMax = () => 2147483648;
      var alignMemory = (size, alignment) => Math.ceil(size / alignment) * alignment;
      var growMemory = (size) => {
        var b = wasmMemory.buffer;
        var pages = (size - b.byteLength + 65535) / 65536 | 0;
        try {
          wasmMemory.grow(pages);
          updateMemoryViews();
          return 1;
        } catch (e) {
        }
      };
      var _emscripten_resize_heap = (requestedSize) => {
        var oldSize = HEAPU8.length;
        requestedSize >>>= 0;
        var maxHeapSize = getHeapMax();
        if (requestedSize > maxHeapSize) {
          return false;
        }
        for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
          var overGrownHeapSize = oldSize * (1 + 0.2 / cutDown);
          overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
          var newSize = Math.min(maxHeapSize, alignMemory(Math.max(requestedSize, overGrownHeapSize), 65536));
          var replacement = growMemory(newSize);
          if (replacement) {
            return true;
          }
        }
        return false;
      };
      var getCFunc = (ident) => {
        var func = Module["_" + ident];
        return func;
      };
      var writeArrayToMemory = (array, buffer) => {
        HEAP8.set(array, buffer);
      };
      var lengthBytesUTF8 = (str) => {
        var len = 0;
        for (var i = 0; i < str.length; ++i) {
          var c = str.charCodeAt(i);
          if (c <= 127) {
            len++;
          } else if (c <= 2047) {
            len += 2;
          } else if (c >= 55296 && c <= 57343) {
            len += 4;
            ++i;
          } else {
            len += 3;
          }
        }
        return len;
      };
      var stringToUTF8Array = (str, heap, outIdx, maxBytesToWrite) => {
        if (!(maxBytesToWrite > 0)) return 0;
        var startIdx = outIdx;
        var endIdx = outIdx + maxBytesToWrite - 1;
        for (var i = 0; i < str.length; ++i) {
          var u = str.charCodeAt(i);
          if (u >= 55296 && u <= 57343) {
            var u1 = str.charCodeAt(++i);
            u = 65536 + ((u & 1023) << 10) | u1 & 1023;
          }
          if (u <= 127) {
            if (outIdx >= endIdx) break;
            heap[outIdx++] = u;
          } else if (u <= 2047) {
            if (outIdx + 1 >= endIdx) break;
            heap[outIdx++] = 192 | u >> 6;
            heap[outIdx++] = 128 | u & 63;
          } else if (u <= 65535) {
            if (outIdx + 2 >= endIdx) break;
            heap[outIdx++] = 224 | u >> 12;
            heap[outIdx++] = 128 | u >> 6 & 63;
            heap[outIdx++] = 128 | u & 63;
          } else {
            if (outIdx + 3 >= endIdx) break;
            heap[outIdx++] = 240 | u >> 18;
            heap[outIdx++] = 128 | u >> 12 & 63;
            heap[outIdx++] = 128 | u >> 6 & 63;
            heap[outIdx++] = 128 | u & 63;
          }
        }
        heap[outIdx] = 0;
        return outIdx - startIdx;
      };
      var stringToUTF8 = (str, outPtr, maxBytesToWrite) => stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite);
      var stackAlloc = (sz) => __emscripten_stack_alloc(sz);
      var stringToUTF8OnStack = (str) => {
        var size = lengthBytesUTF8(str) + 1;
        var ret = stackAlloc(size);
        stringToUTF8(str, ret, size);
        return ret;
      };
      var ccall = (ident, returnType, argTypes, args, opts) => {
        var toC = { string: (str) => {
          var ret2 = 0;
          if (str !== null && str !== void 0 && str !== 0) {
            ret2 = stringToUTF8OnStack(str);
          }
          return ret2;
        }, array: (arr) => {
          var ret2 = stackAlloc(arr.length);
          writeArrayToMemory(arr, ret2);
          return ret2;
        } };
        function convertReturnValue(ret2) {
          if (returnType === "string") {
            return UTF8ToString(ret2);
          }
          if (returnType === "boolean") return Boolean(ret2);
          return ret2;
        }
        var func = getCFunc(ident);
        var cArgs = [];
        var stack = 0;
        if (args) {
          for (var i = 0; i < args.length; i++) {
            var converter = toC[argTypes[i]];
            if (converter) {
              if (stack === 0) stack = stackSave();
              cArgs[i] = converter(args[i]);
            } else {
              cArgs[i] = args[i];
            }
          }
        }
        var ret = func(...cArgs);
        function onDone(ret2) {
          if (stack !== 0) stackRestore(stack);
          return convertReturnValue(ret2);
        }
        ret = onDone(ret);
        return ret;
      };
      var cwrap = (ident, returnType, argTypes, opts) => {
        var numericArgs = !argTypes || argTypes.every((type) => type === "number" || type === "boolean");
        var numericRet = returnType !== "string";
        if (numericRet && numericArgs && !opts) {
          return getCFunc(ident);
        }
        return (...args) => ccall(ident, returnType, argTypes, args, opts);
      };
      var wasmImports = { a: ___assert_fail, c: __emscripten_memcpy_js, b: _emscripten_resize_heap };
      var wasmExports = createWasm();
      var ___wasm_call_ctors = () => (___wasm_call_ctors = wasmExports["e"])();
      var _pffft_aligned_malloc = Module["_pffft_aligned_malloc"] = (a0) => (_pffft_aligned_malloc = Module["_pffft_aligned_malloc"] = wasmExports["f"])(a0);
      var _malloc = Module["_malloc"] = (a0) => (_malloc = Module["_malloc"] = wasmExports["g"])(a0);
      var _pffft_aligned_free = Module["_pffft_aligned_free"] = (a0) => (_pffft_aligned_free = Module["_pffft_aligned_free"] = wasmExports["h"])(a0);
      var _free = Module["_free"] = (a0) => (_free = Module["_free"] = wasmExports["i"])(a0);
      var _pffft_simd_size = Module["_pffft_simd_size"] = () => (_pffft_simd_size = Module["_pffft_simd_size"] = wasmExports["j"])();
      var _pffft_new_setup = Module["_pffft_new_setup"] = (a0, a1) => (_pffft_new_setup = Module["_pffft_new_setup"] = wasmExports["k"])(a0, a1);
      var _pffft_destroy_setup = Module["_pffft_destroy_setup"] = (a0) => (_pffft_destroy_setup = Module["_pffft_destroy_setup"] = wasmExports["l"])(a0);
      var _pffft_zreorder = Module["_pffft_zreorder"] = (a0, a1, a2, a3) => (_pffft_zreorder = Module["_pffft_zreorder"] = wasmExports["m"])(a0, a1, a2, a3);
      var _pffft_zconvolve_accumulate = Module["_pffft_zconvolve_accumulate"] = (a0, a1, a2, a3, a4) => (_pffft_zconvolve_accumulate = Module["_pffft_zconvolve_accumulate"] = wasmExports["n"])(a0, a1, a2, a3, a4);
      var _pffft_transform = Module["_pffft_transform"] = (a0, a1, a2, a3, a4) => (_pffft_transform = Module["_pffft_transform"] = wasmExports["o"])(a0, a1, a2, a3, a4);
      var _pffft_transform_ordered = Module["_pffft_transform_ordered"] = (a0, a1, a2, a3, a4) => (_pffft_transform_ordered = Module["_pffft_transform_ordered"] = wasmExports["p"])(a0, a1, a2, a3, a4);
      var __emscripten_stack_restore = (a0) => (__emscripten_stack_restore = wasmExports["r"])(a0);
      var __emscripten_stack_alloc = (a0) => (__emscripten_stack_alloc = wasmExports["s"])(a0);
      var _emscripten_stack_get_current = () => (_emscripten_stack_get_current = wasmExports["t"])();
      Module["cwrap"] = cwrap;
      Module["setValue"] = setValue;
      Module["getValue"] = getValue;
      var calledRun;
      var calledPrerun;
      dependenciesFulfilled = function runCaller() {
        if (!calledRun) run();
        if (!calledRun) dependenciesFulfilled = runCaller;
      };
      function run() {
        if (runDependencies > 0) {
          return;
        }
        if (!calledPrerun) {
          calledPrerun = 1;
          preRun();
          if (runDependencies > 0) {
            return;
          }
        }
        function doRun() {
          if (calledRun) return;
          calledRun = 1;
          Module["calledRun"] = 1;
          if (ABORT) return;
          initRuntime();
          readyPromiseResolve(Module);
          Module["onRuntimeInitialized"]?.();
          postRun();
        }
        if (Module["setStatus"]) {
          Module["setStatus"]("Running...");
          setTimeout(() => {
            setTimeout(() => Module["setStatus"](""), 1);
            doRun();
          }, 1);
        } else {
          doRun();
        }
      }
      if (Module["preInit"]) {
        if (typeof Module["preInit"] == "function") Module["preInit"] = [Module["preInit"]];
        while (Module["preInit"].length > 0) {
          Module["preInit"].pop()();
        }
      }
      run();
      moduleRtn = readyPromise;
      return moduleRtn;
    });
  })();
  var pffft_default3 = PFFFT2;

  // node_modules/@echogarden/pffft-wasm/dist/simd/pffft.wasm
  var pffft_default4 = __toBinary("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aiIMIDIgKyAz/eYBICkgNP3mAf3lASIqIDYgL/0MejeePno3nj56N54+ejeePv3mASAu/Qy9G08/vRtPP70bTz+9G08//eYB/eUB/eQBIi795AEiL/3mASA3ICz9DHo3nj56N54+ejeePno3nj795gEgLf0MvRtPP70bTz+9G08/vRtPP/3mAf3lAf3kASItICsgJv3mASApICf95gH95QEiJv3lASInID0gQJT9EyIs/eYB/eQB/QsEECAMICcgMv3mASAvICz95gH95QH9CwQAIAcgCCAjakEEdGogMSAmIC395AEiJv3mASAuICr95QEiJyA9ID+U/RMiKv3mAf3lAf0LBAAgByAIICRqQQR0aiAnIDH95gEgJiAq/eYB/eQB/QsEACAHIAggHWpBBHRqIgwgMCA6IDX95QEiJv3mASAoIDj95AEiJyA9ID6U/RMiKP3mAf3kAf0LBBAgDCAnIDD95gEgJiAo/eYB/eUB/QsEACAIQQJqIgggGkgNAAsgASAVaiEBIAcgCUEEdGohByATQQFqIhMgCkcNAAsLDAELQa8KQYcKQakDQdoIEAAACwsgAyACIAMgEkYiEhshASACIAMgEhshEiAJICBBAWtsIBhqIRggBiAhRyAGQQFqIQYgIiEHDQALCyABDwtBkwpBhwpBhwlB+AgQAAALpgYBAn8CQCAAIAFGDQAgASAAIAJqIgRrQQAgAkEBdGtNBEACQCACQYAETwRAIAAgASACEAIMAQsgACACaiEDAkAgACABc0EDcUUEQAJAIABBA3FFDQAgAkUNAANAIAAgAS0AADoAACABQQFqIQEgAEEBaiIAQQNxRQ0BIAAgA0kNAAsLIANBfHEhAgJAIANBwABJDQAgACACQUBqIgRLDQADQCAAIAEoAgA2AgAgACABKAIENgIEIAAgASgCCDYCCCAAIAEoAgw2AgwgACABKAIQNgIQIAAgASgCFDYCFCAAIAEoAhg2AhggACABKAIcNgIcIAAgASgCIDYCICAAIAEoAiQ2AiQgACABKAIoNgIoIAAgASgCLDYCLCAAIAEoAjA2AjAgACABKAI0NgI0IAAgASgCODYCOCAAIAEoAjw2AjwgAUFAayEBIABBQGsiACAETQ0ACwsgACACTw0BA0AgACABKAIANgIAIAFBBGohASAAQQRqIgAgAkkNAAsMAQsg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");

  // src-webview/audioAnalysisWorker.js
  var FORWARD_DIRECTION = 0;
  var REAL_TRANSFORM = 0;
  var MIN_FREQUENCY = 20;
  var MAX_FREQUENCY = 2e4;
  var MIN_DB = -92;
  var MAX_DB = -12;
  var TILE_COLUMN_COUNT = 256;
  var ROW_BUCKET_SIZE = 32;
  var LOW_FREQUENCY_ENHANCEMENT_MAX_FREQUENCY = 1200;
  var QUALITY_PRESETS = {
    balanced: {
      rowsMultiplier: 1.5,
      colsMultiplier: 2.5,
      fftSizes: [2048, 4096, 8192],
      lowFrequencyDecimationFactor: 2
    },
    high: {
      rowsMultiplier: 2.5,
      colsMultiplier: 4,
      fftSizes: [4096, 8192, 16384],
      lowFrequencyDecimationFactor: 4
    },
    max: {
      rowsMultiplier: 4,
      colsMultiplier: 6,
      fftSizes: [8192, 16384, 16384],
      lowFrequencyDecimationFactor: 4
    }
  };
  var pffftRuntimePromise = null;
  var requestQueue = Promise.resolve();
  var analysisState = createEmptyAnalysisState();
  self.onmessage = (event) => {
    const message = event.data;
    switch (message?.type) {
      case "initAnalysis":
        enqueueRequest(async () => {
          const runtime = await getPffftRuntime();
          initAnalysis(runtime, message.body);
        });
        return;
      case "requestSpectrogramTiles":
        enqueueRequest(async () => {
          const runtime = await getPffftRuntime();
          await requestSpectrogramTiles(runtime, message.body);
        });
        return;
      case "cancelGeneration":
        cancelGeneration(message.body?.generation);
        return;
      default:
        return;
    }
  };
  function createEmptyAnalysisState() {
    return {
      initialized: false,
      samples: null,
      sampleRate: 0,
      duration: 0,
      quality: "high",
      minFrequency: MIN_FREQUENCY,
      maxFrequency: MAX_FREQUENCY,
      runtimeVariant: null,
      tileCache: /* @__PURE__ */ new Map(),
      generationStatus: /* @__PURE__ */ new Map(),
      fftResources: /* @__PURE__ */ new Map(),
      bandRangeCache: /* @__PURE__ */ new Map()
    };
  }
  function enqueueRequest(task) {
    requestQueue = requestQueue.then(task).catch((error) => {
      postError(error);
    });
  }
  async function getPffftRuntime() {
    if (!pffftRuntimePromise) {
      pffftRuntimePromise = loadPffftRuntime();
    }
    return pffftRuntimePromise;
  }
  async function loadPffftRuntime() {
    const failures = [];
    for (const loader of [loadSimdRuntime, loadNonSimdRuntime]) {
      try {
        return await loader();
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new Error(`Unable to initialize PFFFT runtime: ${failures.join(" | ")}`);
  }
  async function loadSimdRuntime() {
    const module = await pffft_default3({
      wasmBinary: pffft_default4,
      locateFile: () => "pffft-simd.wasm"
    });
    return {
      module,
      variant: "simd128"
    };
  }
  async function loadNonSimdRuntime() {
    const module = await pffft_default({
      wasmBinary: pffft_default2,
      locateFile: () => "pffft.wasm"
    });
    return {
      module,
      variant: "non-simd"
    };
  }
  function initAnalysis(runtime, options) {
    const samples = new Float32Array(options.samplesBuffer);
    const sampleRate = Number(options.sampleRate);
    const duration = Number(options.duration);
    const quality = normalizeQualityPreset(options.quality);
    if (!samples.length || !Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(duration) || duration <= 0) {
      throw new Error("Audio data is empty.");
    }
    disposeFftResources(runtime.module);
    analysisState = {
      initialized: true,
      samples,
      sampleRate,
      duration,
      quality,
      minFrequency: MIN_FREQUENCY,
      maxFrequency: Math.min(MAX_FREQUENCY, sampleRate / 2),
      runtimeVariant: runtime.variant,
      tileCache: /* @__PURE__ */ new Map(),
      generationStatus: /* @__PURE__ */ new Map(),
      fftResources: /* @__PURE__ */ new Map(),
      bandRangeCache: /* @__PURE__ */ new Map()
    };
    self.postMessage({
      type: "analysisInitialized",
      body: {
        duration,
        maxFrequency: analysisState.maxFrequency,
        minFrequency: analysisState.minFrequency,
        quality,
        runtimeVariant: runtime.variant,
        sampleCount: samples.length,
        sampleRate
      }
    });
  }
  function cancelGeneration(generation) {
    if (!Number.isFinite(generation)) {
      return;
    }
    analysisState.generationStatus.set(generation, { cancelled: true });
  }
  function isGenerationCancelled(generation) {
    return analysisState.generationStatus.get(generation)?.cancelled === true;
  }
  async function requestSpectrogramTiles(runtime, request) {
    if (!analysisState.initialized || !analysisState.samples) {
      throw new Error("Analysis is not initialized.");
    }
    const plan = createRequestPlan(request);
    const existingGenerationStatus = analysisState.generationStatus.get(plan.generation);
    if (existingGenerationStatus?.cancelled) {
      postCancelled(plan);
      return;
    }
    analysisState.generationStatus.set(plan.generation, { cancelled: false });
    if (isGenerationCancelled(plan.generation)) {
      postCancelled(plan);
      return;
    }
    let completedTiles = 0;
    for (let tileIndex = plan.startTileIndex; tileIndex <= plan.endTileIndex; tileIndex += 1) {
      if (isGenerationCancelled(plan.generation)) {
        postCancelled(plan);
        return;
      }
      const cacheKey = buildTileCacheKey(plan, tileIndex);
      let tile = analysisState.tileCache.get(cacheKey);
      let fromCache = true;
      if (!tile) {
        tile = analyzeTile(runtime.module, plan, tileIndex, cacheKey);
        analysisState.tileCache.set(cacheKey, tile);
        fromCache = false;
      }
      completedTiles += 1;
      const tileCopy = tile.buffer.slice();
      self.postMessage(
        {
          type: "spectrogramTile",
          body: {
            columnCount: tile.columnCount,
            completedTiles,
            dprBucket: plan.dprBucket,
            fftSize: plan.fftSize,
            fromCache,
            generation: plan.generation,
            requestKind: plan.requestKind,
            rowCount: tile.rowCount,
            runtimeVariant: analysisState.runtimeVariant,
            tileEnd: tile.tileEnd,
            tileIndex,
            tileKey: cacheKey,
            tileStart: tile.tileStart,
            totalTiles: plan.totalTiles,
            zoomBucket: plan.zoomBucket,
            targetColumns: plan.targetColumns,
            targetRows: plan.rowCount,
            spectrogramBuffer: tileCopy.buffer
          }
        },
        [tileCopy.buffer]
      );
      await yieldToEventLoop();
    }
    if (isGenerationCancelled(plan.generation)) {
      postCancelled(plan);
      return;
    }
    self.postMessage({
      type: "spectrogramTilesComplete",
      body: {
        completedTiles,
        dprBucket: plan.dprBucket,
        fftSize: plan.fftSize,
        generation: plan.generation,
        requestKind: plan.requestKind,
        runtimeVariant: analysisState.runtimeVariant,
        targetColumns: plan.targetColumns,
        targetRows: plan.rowCount,
        totalTiles: plan.totalTiles,
        viewEnd: plan.viewEnd,
        viewStart: plan.viewStart,
        zoomBucket: plan.zoomBucket
      }
    });
  }
  function createRequestPlan(request) {
    const preset = QUALITY_PRESETS[analysisState.quality];
    const requestKind = request?.requestKind === "overview" ? "overview" : "visible";
    const generation = Number.isFinite(request?.generation) ? Number(request.generation) : 0;
    const requestedStart = Number.isFinite(request?.viewStart) ? Number(request.viewStart) : 0;
    const requestedEnd = Number.isFinite(request?.viewEnd) ? Number(request.viewEnd) : analysisState.duration;
    const viewStart = clamp(requestedStart, 0, analysisState.duration);
    const viewEnd = clamp(Math.max(viewStart + 1 / analysisState.sampleRate, requestedEnd), viewStart + 1 / analysisState.sampleRate, analysisState.duration);
    const pixelWidth = Math.max(1, Math.round(Number(request?.pixelWidth) || 1));
    const pixelHeight = Math.max(1, Math.round(Number(request?.pixelHeight) || 1));
    const dprBucket = Math.max(2, Math.round(Number(request?.dpr) || 2));
    const spanSeconds = Math.max(1 / analysisState.sampleRate, viewEnd - viewStart);
    const spanSamples = spanSeconds * analysisState.sampleRate;
    const samplesPerPixel = spanSamples / Math.max(1, pixelWidth);
    const zoomSelection = selectZoomPolicy(preset, samplesPerPixel);
    const bucketedSamplesPerPixel = quantizeSamplesPerPixel(samplesPerPixel);
    const rowCount = quantizeCeil(Math.ceil(pixelHeight * preset.rowsMultiplier), ROW_BUCKET_SIZE);
    const targetColumns = Math.max(
      TILE_COLUMN_COUNT,
      quantizeCeil(Math.ceil(pixelWidth * preset.colsMultiplier), TILE_COLUMN_COUNT / 2)
    );
    const secondsPerColumn = Math.max(
      1 / analysisState.sampleRate,
      bucketedSamplesPerPixel / preset.colsMultiplier / analysisState.sampleRate
    );
    const tileDuration = Math.max(secondsPerColumn * TILE_COLUMN_COUNT, 1 / analysisState.sampleRate);
    const startTileIndex = Math.max(0, Math.floor(viewStart / tileDuration));
    const endTileIndex = Math.max(
      startTileIndex,
      Math.floor(Math.max(viewStart, viewEnd - secondsPerColumn * 0.5) / tileDuration)
    );
    const totalTiles = endTileIndex - startTileIndex + 1;
    return {
      bucketedSamplesPerPixel,
      dprBucket,
      endTileIndex,
      fftSize: zoomSelection.fftSize,
      generation,
      pixelHeight,
      pixelWidth,
      requestKind,
      rowCount,
      secondsPerColumn,
      startTileIndex,
      targetColumns,
      tileDuration,
      totalTiles,
      viewEnd,
      viewStart,
      zoomBucket: `${zoomSelection.bucket}-spp${formatBucketNumber(bucketedSamplesPerPixel)}-rows${rowCount}`
    };
  }
  function selectZoomPolicy(preset, samplesPerPixel) {
    const [highZoomFft, mediumZoomFft, lowZoomFft] = preset.fftSizes;
    const highZoomThreshold = Math.max(32, highZoomFft / preset.colsMultiplier);
    const mediumZoomThreshold = Math.max(highZoomThreshold * 1.75, mediumZoomFft / preset.colsMultiplier);
    if (samplesPerPixel <= highZoomThreshold) {
      return {
        bucket: "high",
        fftSize: highZoomFft
      };
    }
    if (samplesPerPixel <= mediumZoomThreshold) {
      return {
        bucket: "medium",
        fftSize: mediumZoomFft
      };
    }
    return {
      bucket: "low",
      fftSize: lowZoomFft
    };
  }
  function analyzeTile(module, plan, tileIndex, cacheKey) {
    const fftResource = getFftResource(module, plan.fftSize);
    const bandRanges = getBandRanges(plan.fftSize, plan.rowCount);
    const tileStart = tileIndex * plan.tileDuration;
    const tileEnd = Math.min(analysisState.duration, tileStart + plan.tileDuration);
    const tileBuffer = new Float32Array(TILE_COLUMN_COUNT * plan.rowCount);
    const powerSpectrum = new Float32Array(Math.max(2, Math.floor(plan.fftSize / 2) + 1));
    const lowFrequencyEnhancement = createLowFrequencyEnhancement(plan, bandRanges);
    const safeTileSpan = Math.max(1 / analysisState.sampleRate, tileEnd - tileStart);
    for (let columnIndex = 0; columnIndex < TILE_COLUMN_COUNT; columnIndex += 1) {
      const centerRatio = TILE_COLUMN_COUNT === 1 ? 0.5 : (columnIndex + 0.5) / TILE_COLUMN_COUNT;
      const centerTime = tileStart + centerRatio * safeTileSpan;
      const centerSample = Math.round(centerTime * analysisState.sampleRate);
      const windowStart = centerSample - Math.floor(plan.fftSize / 2);
      for (let offset = 0; offset < plan.fftSize; offset += 1) {
        const sourceIndex = windowStart + offset;
        const sample = sourceIndex >= 0 && sourceIndex < analysisState.samples.length ? analysisState.samples[sourceIndex] : 0;
        fftResource.inputView[offset] = sample * fftResource.window[offset];
      }
      module._pffft_transform_ordered(
        fftResource.setup,
        fftResource.inputPointer,
        fftResource.outputPointer,
        fftResource.workPointer,
        FORWARD_DIRECTION
      );
      writePowerSpectrum({
        fftSize: plan.fftSize,
        outputView: fftResource.outputView,
        powerSpectrum
      });
      if (lowFrequencyEnhancement) {
        writeDecimatedFftInput({
          centerSample,
          decimationFactor: lowFrequencyEnhancement.decimationFactor,
          fftResource,
          fftSize: plan.fftSize
        });
        module._pffft_transform_ordered(
          fftResource.setup,
          fftResource.inputPointer,
          fftResource.outputPointer,
          fftResource.workPointer,
          FORWARD_DIRECTION
        );
        writePowerSpectrum({
          fftSize: plan.fftSize,
          outputView: fftResource.outputView,
          powerSpectrum: lowFrequencyEnhancement.powerSpectrum
        });
      }
      writeSpectrogramColumn({
        bandRanges,
        columnOffset: columnIndex,
        lowFrequencyEnhancement,
        powerSpectrum,
        rowCount: plan.rowCount,
        target: tileBuffer
      });
    }
    return {
      buffer: tileBuffer,
      columnCount: TILE_COLUMN_COUNT,
      rowCount: plan.rowCount,
      tileEnd,
      tileStart,
      key: cacheKey
    };
  }
  function createLowFrequencyEnhancement(plan, bandRanges) {
    const preset = QUALITY_PRESETS[analysisState.quality];
    const decimationFactor = Math.max(1, preset.lowFrequencyDecimationFactor || 1);
    if (decimationFactor <= 1) {
      return null;
    }
    const effectiveSampleRate = analysisState.sampleRate / decimationFactor;
    const maximumFrequency = Math.min(
      LOW_FREQUENCY_ENHANCEMENT_MAX_FREQUENCY,
      effectiveSampleRate / 2 * 0.92,
      analysisState.maxFrequency
    );
    if (maximumFrequency <= analysisState.minFrequency * 1.25) {
      return null;
    }
    const enhancedBandRanges = createBandRangesForSampleRate({
      fftSize: plan.fftSize,
      maxFrequency: maximumFrequency,
      minFrequency: analysisState.minFrequency,
      rowCount: plan.rowCount,
      sampleRate: effectiveSampleRate,
      template: bandRanges
    });
    return {
      decimationFactor,
      enhancedBandRanges,
      maxFrequency: maximumFrequency,
      powerSpectrum: new Float32Array(Math.max(2, Math.floor(plan.fftSize / 2) + 1))
    };
  }
  function getFftResource(module, fftSize) {
    const existing = analysisState.fftResources.get(fftSize);
    if (existing) {
      return existing;
    }
    const setup = module._pffft_new_setup(fftSize, REAL_TRANSFORM);
    if (!setup) {
      throw new Error(`PFFFT could not initialize for FFT size ${fftSize}.`);
    }
    const inputPointer = module._pffft_aligned_malloc(fftSize * Float32Array.BYTES_PER_ELEMENT);
    const outputPointer = module._pffft_aligned_malloc(fftSize * Float32Array.BYTES_PER_ELEMENT);
    const workPointer = module._pffft_aligned_malloc(fftSize * Float32Array.BYTES_PER_ELEMENT);
    if (!inputPointer || !outputPointer || !workPointer) {
      throw new Error("PFFFT could not allocate aligned working buffers.");
    }
    const resource = {
      fftSize,
      inputPointer,
      inputView: new Float32Array(module.HEAPF32.buffer, inputPointer, fftSize),
      outputPointer,
      outputView: new Float32Array(module.HEAPF32.buffer, outputPointer, fftSize),
      setup,
      window: createHannWindow(fftSize),
      workPointer
    };
    analysisState.fftResources.set(fftSize, resource);
    return resource;
  }
  function getBandRanges(fftSize, rowCount) {
    const cacheKey = `${fftSize}:${analysisState.sampleRate}:${rowCount}:${analysisState.maxFrequency}`;
    const existing = analysisState.bandRangeCache.get(cacheKey);
    if (existing) {
      return existing;
    }
    const bandRanges = createLogBandRanges({
      fftSize,
      maxFrequency: analysisState.maxFrequency,
      minFrequency: analysisState.minFrequency,
      rows: rowCount,
      sampleRate: analysisState.sampleRate
    });
    analysisState.bandRangeCache.set(cacheKey, bandRanges);
    return bandRanges;
  }
  function disposeFftResources(module) {
    for (const resource of analysisState.fftResources.values()) {
      module._pffft_destroy_setup(resource.setup);
      module._pffft_aligned_free(resource.inputPointer);
      module._pffft_aligned_free(resource.outputPointer);
      module._pffft_aligned_free(resource.workPointer);
    }
  }
  function createHannWindow(size) {
    const window2 = new Float32Array(size);
    for (let index = 0; index < size; index += 1) {
      window2[index] = 0.5 * (1 - Math.cos(2 * Math.PI * index / (size - 1)));
    }
    return window2;
  }
  function createLogBandRanges({ fftSize, maxFrequency, minFrequency, rows, sampleRate }) {
    const bandRanges = [];
    const nyquist = sampleRate / 2;
    const maximumBin = Math.max(2, Math.floor(fftSize / 2));
    const safeMinFrequency = Math.max(1, minFrequency);
    const safeMaxFrequency = Math.max(safeMinFrequency * 1.01, maxFrequency);
    for (let row = 0; row < rows; row += 1) {
      const startRatio = row / rows;
      const endRatio = (row + 1) / rows;
      const startFrequency = safeMinFrequency * (safeMaxFrequency / safeMinFrequency) ** startRatio;
      const endFrequency = safeMinFrequency * (safeMaxFrequency / safeMinFrequency) ** endRatio;
      const startBin = clamp(Math.floor(startFrequency / nyquist * maximumBin), 1, maximumBin - 1);
      const endBin = clamp(Math.ceil(endFrequency / nyquist * maximumBin), startBin + 1, maximumBin);
      bandRanges.push({
        endBin,
        endFrequency,
        startBin,
        startFrequency
      });
    }
    return bandRanges;
  }
  function writeSpectrogramColumn({ bandRanges, columnOffset, lowFrequencyEnhancement, powerSpectrum, rowCount, target }) {
    for (let row = 0; row < rowCount; row += 1) {
      const range = bandRanges[row];
      const useLowFrequencyEnhancement = shouldUseLowFrequencyEnhancement(range, lowFrequencyEnhancement);
      const activeRange = useLowFrequencyEnhancement ? lowFrequencyEnhancement.enhancedBandRanges[row] : range;
      const activePowerSpectrum = useLowFrequencyEnhancement ? lowFrequencyEnhancement.powerSpectrum : powerSpectrum;
      const { startBin, endBin } = activeRange;
      const bandSize = Math.max(1, endBin - startBin);
      let weightedEnergy = 0;
      let totalWeight = 0;
      for (let bin = startBin; bin < endBin; bin += 1) {
        const position = bandSize === 1 ? 0.5 : (bin - startBin + 0.5) / bandSize;
        const taper = 1 - Math.abs(position * 2 - 1);
        const weight = 0.7 + taper * 0.3;
        weightedEnergy += activePowerSpectrum[bin] * weight;
        totalWeight += weight;
      }
      const rms = Math.sqrt(weightedEnergy / Math.max(totalWeight, 1e-8));
      const decibels = 20 * Math.log10(rms + 1e-7);
      const normalized = (decibels - MIN_DB) / (MAX_DB - MIN_DB);
      const targetRow = rowCount - row - 1;
      target[columnOffset * rowCount + targetRow] = clamp(normalized, 0, 1);
    }
  }
  function writePowerSpectrum({ fftSize, outputView, powerSpectrum }) {
    const maximumBin = Math.max(2, Math.floor(fftSize / 2));
    const normalizationFactor = (fftSize / 2) ** 2;
    powerSpectrum.fill(0);
    for (let bin = 1; bin < maximumBin; bin += 1) {
      const real = outputView[bin * 2];
      const imaginary = outputView[bin * 2 + 1];
      powerSpectrum[bin] = (real * real + imaginary * imaginary) / normalizationFactor;
    }
  }
  function writeDecimatedFftInput({ centerSample, decimationFactor, fftResource, fftSize }) {
    const decimatedWindowStart = centerSample - Math.floor(fftSize * decimationFactor / 2);
    for (let offset = 0; offset < fftSize; offset += 1) {
      let sum = 0;
      for (let tap = 0; tap < decimationFactor; tap += 1) {
        const sourceIndex = decimatedWindowStart + offset * decimationFactor + tap;
        sum += sourceIndex >= 0 && sourceIndex < analysisState.samples.length ? analysisState.samples[sourceIndex] : 0;
      }
      fftResource.inputView[offset] = sum / decimationFactor * fftResource.window[offset];
    }
  }
  function createBandRangesForSampleRate({ fftSize, maxFrequency, minFrequency, rowCount, sampleRate, template }) {
    const nyquist = sampleRate / 2;
    const maximumBin = Math.max(2, Math.floor(fftSize / 2));
    return template.slice(0, rowCount).map((range) => {
      const startFrequency = Math.min(
        Math.max(minFrequency, range.startFrequency),
        maxFrequency * 0.999
      );
      const endFrequency = Math.min(
        maxFrequency,
        Math.max(startFrequency * 1.01, range.endFrequency)
      );
      const startBin = clamp(Math.floor(startFrequency / nyquist * maximumBin), 1, maximumBin - 1);
      const endBin = clamp(Math.ceil(endFrequency / nyquist * maximumBin), startBin + 1, maximumBin);
      return {
        endBin,
        endFrequency,
        startBin,
        startFrequency
      };
    });
  }
  function shouldUseLowFrequencyEnhancement(range, lowFrequencyEnhancement) {
    return Boolean(lowFrequencyEnhancement) && range.endFrequency <= lowFrequencyEnhancement.maxFrequency;
  }
  function buildTileCacheKey(plan, tileIndex) {
    return [
      analysisState.quality,
      plan.zoomBucket,
      `tile${tileIndex}`,
      `dpr${plan.dprBucket}`
    ].join(":");
  }
  function normalizeQualityPreset(value) {
    return value === "balanced" || value === "max" ? value : "high";
  }
  function quantizeSamplesPerPixel(samplesPerPixel) {
    const safeValue = Math.max(1, samplesPerPixel);
    const bucketExponent = Math.round(Math.log2(safeValue) * 2) / 2;
    return 2 ** bucketExponent;
  }
  function quantizeCeil(value, bucketSize) {
    return Math.max(bucketSize, Math.ceil(value / bucketSize) * bucketSize);
  }
  function formatBucketNumber(value) {
    return String(Math.round(value * 100) / 100).replace(".", "_");
  }
  function yieldToEventLoop() {
    return new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  function postCancelled(plan) {
    self.postMessage({
      type: "spectrogramTilesCancelled",
      body: {
        generation: plan.generation,
        requestKind: plan.requestKind
      }
    });
  }
  function postError(error) {
    const text = error instanceof Error ? error.message : String(error);
    self.postMessage({
      type: "error",
      body: { message: text }
    });
  }
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
})();
