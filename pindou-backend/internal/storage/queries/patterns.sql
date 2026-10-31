-- 图纸与分类、首页公告（迁移 025）。图片本身只在 PatternImage、PatternThumbnail 里读，列表不带。

-- name: PatternCategories :many
SELECT id, name, position, enabled FROM pattern_categories ORDER BY position, created_at, id;

-- name: InsertPatternCategory :exec
INSERT INTO pattern_categories(id, name, position, enabled, created_at, updated_by, updated_at)
VALUES (@id, @name, (SELECT coalesce(max(position), 0) + 1 FROM pattern_categories), true, @updated_at, @updated_by, @updated_at);

-- name: UpdatePatternCategory :execrows
UPDATE pattern_categories SET name = @name, enabled = @enabled, updated_by = @updated_by, updated_at = @updated_at WHERE id = @id;

-- name: DeletePatternCategory :execrows
-- 只删空分类：里面还有图纸（含下架的）时一行都不删。
DELETE FROM pattern_categories c WHERE c.id = @id AND NOT EXISTS (SELECT 1 FROM patterns p WHERE p.category_id = c.id);

-- name: SetPatternCategoryPosition :exec
UPDATE pattern_categories SET position = @position WHERE id = @id;

-- name: Patterns :many
SELECT id, name, category_id, published, first_published_at, position, width, height, image_version, created_at, updated_at
FROM patterns ORDER BY position, created_at DESC, id;

-- name: PatternImage :many
SELECT image, image_type, image_version FROM patterns WHERE id = @id;

-- name: PatternThumbnail :many
SELECT thumbnail, image_version FROM patterns WHERE id = @id;

-- 新传的排在最前面。
-- name: InsertPattern :exec
INSERT INTO patterns(id, name, category_id, published, first_published_at, position, image, image_type, thumbnail, width, height,
  image_version, created_by, created_at, updated_by, updated_at)
VALUES (@id, @name, sqlc.narg(category_id), @published, sqlc.narg(first_published_at), (SELECT coalesce(min(position), 1) - 1 FROM patterns),
  @image, @image_type, @thumbnail, @width, @height, @image_version, @updated_by, @updated_at, @updated_by, @updated_at);

-- name: UpdatePattern :execrows
UPDATE patterns SET name = @name, category_id = sqlc.narg(category_id), published = @published, first_published_at = sqlc.narg(first_published_at),
  updated_by = @updated_by, updated_at = @updated_at
WHERE id = @id;

-- name: ReplacePatternImage :execrows
UPDATE patterns SET image = @image, image_type = @image_type, thumbnail = @thumbnail, width = @width, height = @height,
  image_version = @image_version, updated_by = @updated_by, updated_at = @updated_at
WHERE id = @id;

-- name: DeletePattern :execrows
DELETE FROM patterns WHERE id = @id;

-- name: SetPatternPosition :exec
UPDATE patterns SET position = @position WHERE id = @id;

-- 首页公告：没有行表示没有公告；expires_on 为空串表示不过期。
-- name: StorefrontAnnouncement :many
SELECT body, coalesce(to_char(expires_on, 'YYYY-MM-DD'), '')::text AS expires_on, updated_by::text AS updated_by, updated_at
FROM storefront_announcement WHERE id = true;

-- name: SaveStorefrontAnnouncement :exec
INSERT INTO storefront_announcement(id, body, expires_on, updated_by, updated_at)
VALUES (true, @body, NULLIF(@expires_on::text, '')::date, @updated_by, @updated_at)
ON CONFLICT (id) DO UPDATE SET body = excluded.body, expires_on = excluded.expires_on, updated_by = excluded.updated_by, updated_at = excluded.updated_at;

-- name: ClearStorefrontAnnouncement :exec
DELETE FROM storefront_announcement WHERE id = true;
