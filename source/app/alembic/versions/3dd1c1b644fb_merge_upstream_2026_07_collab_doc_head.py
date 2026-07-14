"""Merge upstream 2026-07 collab_doc head

Upstream pushed 5 more commits after our initial sync point (86a05892),
including e2f3g4h5i6j7 (add_collab_doc) chained off d1e2f3a4b5c6 — the
same parent our earlier merge migration (cc42df8caf1b) already used,
so pulling them in re-forked the alembic head into two.

Revision ID: 3dd1c1b644fb
Revises: cc42df8caf1b, e2f3g4h5i6j7
Create Date: 2026-07-07 00:00:00.000000

"""

# revision identifiers, used by Alembic.
revision = '3dd1c1b644fb'
down_revision = ('cc42df8caf1b', 'e2f3g4h5i6j7')
branch_labels = None
depends_on = None


def upgrade():
    # No schema changes — merge point. Both branches are additive and
    # schema-compatible up to this point.
    pass


def downgrade():
    pass
