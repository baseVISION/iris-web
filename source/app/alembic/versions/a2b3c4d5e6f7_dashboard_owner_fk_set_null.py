"""custom_dashboard.owner_id FK: SET NULL on user delete instead of blocking.

Deleting a user who owns a custom dashboard raised a raw
ForeignKeyViolation/500 instead of either succeeding or returning a clean
4xx, because `custom_dashboard_owner_id_fkey` had no ON DELETE rule. Shared
dashboards should survive their owner's account being removed, so orphan
them (owner_id -> NULL) rather than blocking the delete or cascading it.

Idempotent via `_has_table`/`_table_has_column`.

Revision ID: a2b3c4d5e6f7
Revises: db034de157b9
Create Date: 2026-07-08 00:00:00.000000
"""
from alembic import op

from app.alembic.alembic_utils import _has_table
from app.alembic.alembic_utils import _table_has_column


revision = 'a2b3c4d5e6f7'
down_revision = 'db034de157b9'
branch_labels = None
depends_on = None


def upgrade():
    if not _has_table('custom_dashboard') or not _table_has_column('custom_dashboard', 'owner_id'):
        return
    op.drop_constraint('custom_dashboard_owner_id_fkey', 'custom_dashboard', type_='foreignkey')
    op.create_foreign_key(
        'custom_dashboard_owner_id_fkey',
        'custom_dashboard', 'user',
        ['owner_id'], ['id'],
        ondelete='SET NULL',
    )


def downgrade():
    if not _has_table('custom_dashboard') or not _table_has_column('custom_dashboard', 'owner_id'):
        return
    op.drop_constraint('custom_dashboard_owner_id_fkey', 'custom_dashboard', type_='foreignkey')
    op.create_foreign_key(
        'custom_dashboard_owner_id_fkey',
        'custom_dashboard', 'user',
        ['owner_id'], ['id'],
    )
