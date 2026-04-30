import fs from 'fs';
const wasmBytes = fs.readFileSync('./deepseek.wasm');
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
logToFile(Object.keys(instance.exports).sort());
