"""Merge dashboard_owner_fk and collab_doc_seeder_version heads

Our custom_dashboard.owner_id FK fix (a2b3c4d5e6f7) was based on
db034de157b9, but merging in 3 newer upstream commits added
f3a1b2c3d4e5 (add_collab_doc_seeder_version) on a sibling branch off
e2f3g4h5i6j7, re-forking the alembic head into two.

Revision ID: b5c6d7e8f9a0
Revises: a2b3c4d5e6f7, f3a1b2c3d4e5
Create Date: 2026-07-08 00:00:00.000000

"""

# revision identifiers, used by Alembic.
revision = 'b5c6d7e8f9a0'
down_revision = ('a2b3c4d5e6f7', 'f3a1b2c3d4e5')
branch_labels = None
depends_on = None


def upgrade():
    # No schema changes — merge point. Both branches are additive and
    # schema-compatible up to this point.
    pass


def downgrade():
    pass
