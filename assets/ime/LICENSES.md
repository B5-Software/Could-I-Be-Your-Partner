# IME 词库数据来源与许可证

由 `scripts/build-ime-dicts.js` 下载生成，自动生成的文件请勿手改。

## 中文拼音词库（ime-dict-zh.js）
- 来源：[雾凇拼音](https://github.com/iDvel/rime-ice) `cn_dicts/8105.dict.yaml`、`cn_dicts/base.dict.yaml`、`cn_dicts/ext.dict.yaml`
- 许可证：GPL-3.0（与主程序一致）
- 上游作者：Dvel 等，见 https://github.com/iDvel/rime-ice

## 英文预测词库（ime-dict-en.js）
- 来源：[雾凇拼音](https://github.com/iDvel/rime-ice) `en_dicts/en.dict.yaml`
- 许可证：GPL-3.0

## 德文预测词库（ime-dict-de.js）
- 来源：[Leipzig Wortschatz Corpora](https://wortschatz.uni-leipzig.de/en/download) `deu_news_2022_10k`
- 许可证：CC BY 4.0

## 生成方式
```bash
node scripts/build-ime-dicts.js
```
