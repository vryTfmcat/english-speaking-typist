# 英语发声打字机

一个完全离线、以键盘反馈为核心的英语拼写与 IPA 练习网页。它把逐键字母名、字母组合音素、完整单词发音和音素键盘放进同一个练习循环。

公开演示：<https://amd-fedor.tail73cba1.ts.net:8443/>

## 功能

- **拼写练习**：30 个手机界面与编程单词；支持上一个、下一个和重复练习当前单词。
- **自由输入**：输入不超过 256 个字符的英文，取得 eSpeak NG 的美式 IPA 和朗读。
- **音素键盘**：用物理键或屏幕按钮输入 40 个 IPA 音素，逐音播放并合成整段。
- **本机记录**：正确率、错词、音量和语速只保存在浏览器 `localStorage`，不上传。

## 本地运行

需要 Python 3.9 或更高版本和 eSpeak NG。macOS 可先安装：

```bash
brew install espeak-ng
```

启动服务：

```bash
cd english-speaking-typist
python3 server.py
```

打开 <http://127.0.0.1:8775>，并先点击“启用声音”。也可以使用 `python3 server.py --port 8780` 指定端口。服务始终只监听 `127.0.0.1`。

## 音素键盘布局

| 物理键 | 音素 |
|---|---|
| Q–P | `/i ɪ ɛ æ ɑ ɔ ʊ u ʌ ə/` |
| Shift+Q–Y | `/eɪ aɪ ɔɪ aʊ oʊ ɝ/` |
| A–H | `/p b t d k g/` |
| J K L ; | `/f v θ ð/` |
| Z–M | `/s z ʃ ʒ h tʃ dʒ/` |
| Shift+A–J | `/m n ŋ l ɹ j w/` |

## 接口

- `GET /api/health`：检查 eSpeak NG 状态。
- `POST /api/analyze`：`{"text":"permission"}`。
- `POST /api/speech`：文本使用 `{"mode":"text","value":"permission","rate":145}`；音素使用 `{"mode":"phonemes","value":["K","AE","T"],"rate":145}`。

音素接口只接受 `data/phonemes.json` 中的 ID。eSpeak 调用使用参数数组和标准输入，不经过 shell；生成的 WAV 只缓存在系统临时目录。

## 测试

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/core.test.mjs
```

## 当前限制

- 只提供 `en-us` 美式发音，音色为适合教学反馈的机械合成音。
- 自由输入没有可靠的字母—音素自动对齐，因此不会伪造字母组合反馈。
- 内置词采用项目内人工校对数据，暂未引入完整 CMUdict。
- 公开演示通过 Tailscale Funnel 转发，可能受其带宽和服务可用性限制。

## 许可

[MIT](LICENSE)
