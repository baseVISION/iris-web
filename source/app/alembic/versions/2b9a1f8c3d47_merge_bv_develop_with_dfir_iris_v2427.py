"""Merge bv-develop chain with dfir-iris v2.4.27 chain

Both chains share common ancestor d5a720d1b99b, then diverged:
- dfir-iris added e5d79b8c4a55 (custom_dashboard tables, 2025-11-10)
- bv-develop added 3715d4fac4de + afcff5ebcf7c (IOC-case link, force-confirmation setting)

This merge point allows databases migrated from dfir-iris v2.4.27 to be
upgraded to bv-develop without a crash.

Revision ID: 2b9a1f8c3d47
Revises: afcff5ebcf7c, e5d79b8c4a55
Create Date: 2026-05-15 00:00:00.000000

"""

# revision identifiers, used by Alembic.
revision = '2b9a1f8c3d47'
down_revision = ('afcff5ebcf7c', 'e5d79b8c4a55')
branch_labels = None
depends_on = None


def upgrade():
    # No schema changes — this is a pure merge point.
    # Both branches are additive and schema-compatible at this point.
    pass


def downgrade():
    pass
