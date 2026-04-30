import fs from 'fs';
const wasmBytes = fs.readFileSync('./deepseek.wasm');
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
console.log(Object.keys(instance.exports).sort());
