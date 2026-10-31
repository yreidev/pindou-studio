-- 顾客的「做图纸」工具（迁移 027，docs/plan-bead-maker.md）。

-- 店里做图纸用的豆子：没有行表示没设置过。
-- name: BeadSettings :many
SELECT palette, available, boxes, board_size, bead_size, revision, updated_at FROM bead_settings WHERE id = true;

-- name: SaveBeadSettings :exec
INSERT INTO bead_settings(id, palette, available, boxes, board_size, bead_size, revision, updated_by, updated_at)
VALUES (true, @palette, @available, @boxes, @board_size, @bead_size, @revision, @updated_by, @updated_at)
ON CONFLICT (id) DO UPDATE SET palette = excluded.palette, available = excluded.available, boxes = excluded.boxes,
  board_size = excluded.board_size, bead_size = excluded.bead_size, revision = excluded.revision,
  updated_by = excluded.updated_by, updated_at = excluded.updated_at;

-- 我的图纸列表：不带完整格子，新改的在前。
-- name: BeadPatternsOf :many
SELECT id, name, palette, width, height, colors, preview, preview_width, preview_height, beads, done_beads, revision, created_at, updated_at
FROM bead_patterns WHERE account_id = @account_id ORDER BY updated_at DESC, id;

-- name: CountBeadPatterns :one
SELECT count(*) FROM bead_patterns WHERE account_id = @account_id;

-- 一张图纸（含格子）；保存前锁住这一行再核对修订号。不是本人的当作没有。
-- name: BeadPattern :many
SELECT id, name, palette, width, height, colors, cells, done, beads, done_beads, revision, created_at, updated_at
FROM bead_patterns WHERE id = @id AND account_id = @account_id;

-- name: LockBeadPattern :many
SELECT id, account_id, name, palette, width, height, colors, cells, done, revision, created_at
FROM bead_patterns WHERE id = @id FOR UPDATE;

-- name: InsertBeadPattern :exec
INSERT INTO bead_patterns(id, account_id, name, palette, width, height, colors, cells, done, preview, preview_width, preview_height,
  beads, done_beads, revision, created_at, updated_at)
VALUES (@id, @account_id, @name, @palette, @width, @height, @colors, @cells, @done, @preview, @preview_width, @preview_height,
  @beads, @done_beads, 1, @now, @now);

-- name: UpdateBeadPattern :exec
UPDATE bead_patterns SET name = @name, palette = @palette, width = @width, height = @height, colors = @colors, cells = @cells,
  done = @done, preview = @preview, preview_width = @preview_width, preview_height = @preview_height, beads = @beads,
  done_beads = @done_beads, revision = revision + 1, updated_at = @now
WHERE id = @id AND account_id = @account_id;

-- name: DeleteBeadPattern :execrows
DELETE FROM bead_patterns WHERE id = @id AND account_id = @account_id;
