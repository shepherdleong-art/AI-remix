# TimelineEditor 重构交付报告

## TL;DR
修复了页面跳动 + TTS 时长不匹配 + 构建了专业级三轨剪辑界面（Video Track / Trim Bar / Audio Track）。

## 改动文件清单

| # | 文件 | 改动 |
|---|------|------|
| 1 | `backend/services/video_service.py` | 新增 `get_audio_duration()` |
| 2 | `backend/services/ai_service.py` | match 输出加 `source_duration` |
| 3 | `backend/routes/ai_editing.py` | 新 `/generate-tts` 端点 + composite 增强 + match 补全 source_duration |
| 4 | `src/renderer/store/editing-store.ts` | 加 `source_duration` / `audioDuration` / `audioPath` |
| 5 | `src/renderer/components/analysis/AiScriptEditor.tsx` | handleRun 新增加 TTS 时长同步 |
| 6 | `src/renderer/components/analysis/TimelineEditor.tsx` | 完整重写为专业剪辑界面 |

## 关键功能

1. **页面跳动修复** — useMemo 缓存所有计算值 + useRef 稳定 scrub interval
2. **TTS 时长匹配** — AI 分析后自动生成 TTS，按比例缩放视频片段时长，与音频对齐
3. **三轨剪辑界面** — Video Track (缩略图) + Trim Bar (出入点拖拽手柄) + Audio Track (口播文字)
4. **素材区间调整** — 拖拽白色手柄调整每个片段使用的素材区间（入点/出点）
5. **一键同步** — 口播时长不匹配时一键等比缩放

## 编译验证
- TypeScript: 零错误 ✅
- Python: 语法全部通过 ✅
