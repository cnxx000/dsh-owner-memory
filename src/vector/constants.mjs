import os from 'node:os';
import path from 'node:path';

export const MODEL_ID = 'Xenova/bge-small-zh-v1.5';
export const MODEL_REV = '75c43b069aac4d136ba6bc1122f995fedcfd2781';
export const MODEL_REV_SHORT = '75c43b0';
export const MODEL_DIR_NAME = `bge-small-zh-v1.5@${MODEL_REV_SHORT}`;
export const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';
export const VECTOR_DIM = 512;
export const EVENT_SEARCH_TEXT_VERSION = 1;
export const VECTOR_FORMAT = 'dsh-owner-memory-int8-v2';

export const MODEL_FILES = Object.freeze([
  Object.freeze({
    name: 'config.json',
    bytes: 716,
    sha256: 'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f',
  }),
  Object.freeze({
    name: 'special_tokens_map.json',
    bytes: 125,
    sha256: 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3',
  }),
  Object.freeze({
    name: 'tokenizer.json',
    bytes: 439125,
    sha256: '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26',
  }),
  Object.freeze({
    name: 'tokenizer_config.json',
    bytes: 367,
    sha256: 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a',
  }),
  Object.freeze({
    name: 'vocab.txt',
    bytes: 109540,
    sha256: '45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c',
  }),
  Object.freeze({
    name: 'onnx/model_int8.onnx',
    bytes: 23_903_394,
    sha256: 'b9837c19ce154ff0726d398ee77abbc03a7faf0476c6f93016c84e531be7ebb5',
  }),
]);

export function modelDirectory(home = os.homedir()) {
  return path.join(home, '.dsh', 'owner-memory', 'models', MODEL_DIR_NAME);
}

export function modelFileUrl(name) {
  const encoded = name.split('/').map(encodeURIComponent).join('/');
  return `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REV}/${encoded}?download=true`;
}
