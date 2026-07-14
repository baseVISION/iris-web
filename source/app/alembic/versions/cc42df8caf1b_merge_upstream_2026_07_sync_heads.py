"""Merge upstream 2026-07 sync heads

Syncing upstream/develop (through 86a05892, 2026-07-03) into bv-develop
introduced a second alembic head: d1e2f3a4b5c6 (add_war_room_id_to_user_activity),
built on top of upstream's own migration chain, diverging from bv-develop's
prior merge point 2b9a1f8c3d47.

Revision ID: cc42df8caf1b
Revises: 2b9a1f8c3d47, d1e2f3a4b5c6
Create Date: 2026-07-07 00:00:00.000000

"""

# revision identifiers, used by Alembic.
revision = 'cc42df8caf1b'
down_revision = ('2b9a1f8c3d47', 'd1e2f3a4b5c6')
branch_labels = None
depends_on = None


def upgrade():
    # No schema changes — merge point. Both branches are additive and
    # schema-compatible up to this point.
    pass


def downgrade():
    pass
