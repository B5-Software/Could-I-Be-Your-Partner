# app-parts

`src/renderer/js/app.js` 由这个目录中的文件按文件名顺序拼接生成，
并以 **ESM** 输出（`export default (async function appEntry() { ... })();`），
页面通过 `<script type="module">` 加载。

- 所有 part 共享 `appEntry` 的作用域，可直接互相引用（与旧的单一 IIFE 一致）。
- part 文件内不要再自行包 `(async function(){ ... })();`，
  入口包装由 `scripts/build-app-bundle.js` 统一添加。

修改 UI 控制器时请编辑对应的 part 文件，然后运行：

```bash
npm run build-app-bundle
```

`npm start`、`npm test` 和打包脚本会自动执行拼接，通常无需手动运行。
