# 追加: タスク層（task layer）

MilestoneGantt に「タスク」を足した差分。マイルストーン＝手で置く点、タスク＝
依存と effort から自動配置されるバー、という切り分け。

## 変わったこと
- **`milestones` テーブルに `kind`(milestone|task) と `effort`(日) を追加**（既存DBは自動マイグレーション）。
- **フォワードパスのスケジューラ**（`compute_schedule` / `ms_view`）。task は `c_start`/`c_end`、
  milestone は `c_ready`/`c_slip` を計算して `/api/state`・SocketIO・REST に**乗せて返す（保存しない）**。
- フロント：`kind=task` はバー描画、`kind=milestone` は従来の菱形。
  **タスクのバーをドラッグ＝effort 伸縮**（離すと `update_ms` で effort を送る → 再計算で並び直し）。
- マイルストーンの `c_slip > 0` は**赤＋「+Nd」**で遅延表示。
- 追加/編集モーダルに **種別** と **effort（日）** を追加。
- 依存（既存の矢印・REST `/api/deps`）はそのまま。task↔milestone も繋げる。

## 動かす
```
pip install -r requirements.txt
python app.py        # → http://localhost:5000
```
初回はサンプル（マイルストーン8＋タスク3＋依存）入りで起動。

## 試すと早い
1. 日ズームで Phase 2/3 のタスクバー（API実装・画面実装・結合テスト）を見る。
2. バーの右側をドラッグ → effort が伸縮し、後続タスク・下流マイルストーンが動く。
3. あるマイルストーンの手前タスクを長くして期限を追い越すと、菱形が赤＋「+Nd」。
4. AI/スクリプトからは同じことを `PATCH /api/milestones/<id> {"effort":N}` で。人の操作と同一経路。

## 既知の割り切り（必要なら次の一手）
- バー位置は `dateToCol` 基準。**週・月ズームでは粒度が粗く**短いタスクが潰れる（タスクは日ズーム前提）。
- 依存矢印は従来どおり常時表示。プロトタイプの「選択時だけ連鎖を光らせる」は未移植（追加可能）。
- task の `date` 列はスケジュール上は無視（計算が優先）。
