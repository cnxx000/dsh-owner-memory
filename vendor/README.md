# Vendored vector runtime

The vector pipeline deliberately does not install `@huggingface/transformers`.
Its Node entry point selects `onnxruntime-node`, which is a native add-on.  The
files in this directory are the browser/web build and WebAssembly runtime only.

## Sources

- `transformers.min.js`
  - package: `@xenova/transformers@2.17.2`
  - tarball: https://registry.npmjs.org/@xenova/transformers/-/transformers-2.17.2.tgz
  - npm integrity: `sha512-lZmHqzrVIkSvZdKZEx7IYY51TK0WDrC8eR0c5IMnBsO8di8are1zzw8BlLhyO2TklZKLN5UffNGs1IJwT6oOqQ==`
  - SHA-256: `bcf7cf304e51f470ed59409622b9d6ffbad80dfcf5baf6a40c919e4b9c4ff812`
- `ort-wasm*.wasm`
  - package: `onnxruntime-web@1.14.0` (the exact dependency of the build above)
  - tarball: https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.14.0.tgz
  - npm integrity: `sha512-Kcqf43UMfW8mCydVGcX9OMXI2VN17c0p6XvR7IPSZzBf/6lteBzXHvcEVWDPmCKuGombl997HgLqj91F11DzXw==`

## File hashes

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `transformers.min.js` | 897938 | `bcf7cf304e51f470ed59409622b9d6ffbad80dfcf5baf6a40c919e4b9c4ff812` |
| `ort-wasm.wasm` | 9223228 | `bbdcb6b3c7d294577d806077630460be4e13ca35a345acb5e81188e9649fa74a` |
| `ort-wasm-simd.wasm` | 10014674 | `9bd07bababc65f53d061f457233eeae501be7ceb8a2adb9eef52d87fe776d865` |
| `ort-wasm-threaded.wasm` | 9149637 | `2ee2f715093aaacc0344bfb1610313eb49a3474e8afde5e4635f30ddfc7615c8` |
| `ort-wasm-simd-threaded.wasm` | 9960821 | `ac23f2f3cbd519a65a0796f7c79eb34ead4c1f6f31eb06e14ed8a9579d697ef6` |
| `LICENSE.onnxruntime.txt` | 1073 | `2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c` |

`LICENSE.transformers.txt` is the Apache-2.0 license shipped in the
Transformers.js tarball. `LICENSE.onnxruntime.txt` is the MIT license from:
https://raw.githubusercontent.com/microsoft/onnxruntime/v1.14.0/LICENSE
