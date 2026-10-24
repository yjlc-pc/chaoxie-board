#!/usr/bin/env node
/* ============================================================
   build-strokes.mjs —— 从 hanzi-writer-data 压平出笔画数表
   用法：
     npm pack --registry=https://registry.npmmirror.com hanzi-writer-data@2.0
     tar xzf hanzi-writer-data-*.tgz && mv package vendor/hanzi-writer-data
     node tools/build-strokes.mjs
     rm -rf vendor/hanzi-writer-data *.tgz
   ============================================================ */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'vendor/hanzi-writer-data';
const OUT = 'data/strokes.json';

const table = {};
for (const file of readdirSync(SRC)) {
    if (!file.endsWith('.json')) continue;
    const char = file.slice(0, -5);
    try {
        const data = JSON.parse(readFileSync(join(SRC, file), 'utf8'));
        if (Array.isArray(data.medians) && data.medians.length) {
            table[char] = data.medians.length;
        }
    } catch (error) {
        /* 跳过坏文件 */
    }
}

mkdirSync('data', { recursive: true });
writeFileSync(OUT, JSON.stringify(table));
console.log(`笔画数表：${Object.keys(table).length} 字，${(statSync(OUT).size / 1024).toFixed(0)} KB`);
