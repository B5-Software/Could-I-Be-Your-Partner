# app-parts

`src/renderer/js/app.js` 由这个目录中的文件按文件名顺序拼接生成。

修改 UI 控制器时请编辑对应的 part 文件，然后运行：

```bash
npm run build-app-bundle
```

`npm start`、`npm test` 和打包脚本会自动执行拼接，通常无需手动运行。
