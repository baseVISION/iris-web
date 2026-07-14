"""war_room_id fkey set null on delete

`war_room_delete()` (business/war_rooms.py) intentionally deletes the
row directly rather than nulling out every activity log entry that
references it, on the assumption that the FK would just go NULL. But
the FK had no ON DELETE behaviour, so Postgres blocked the delete with
a ForeignKeyViolation the moment any activity (even the war room's own
creation) had been logged against it — i.e. every real war room.

Revision ID: db034de157b9
Revises: 3dd1c1b644fb
Create Date: 2026-07-07 00:00:00.000000

"""
from alembic import op


# revision identifiers, used by Alembic.
revision = 'db034de157b9'
down_revision = '3dd1c1b644fb'
branch_labels = None
depends_on = None


def upgrade():
    op.drop_constraint('user_activity_war_room_id_fkey', 'user_activity', type_='foreignkey')
    op.create_foreign_key(
        'user_activity_war_room_id_fkey',
        'user_activity', 'war_room',
        ['war_room_id'], ['war_room_id'],
        ondelete='SET NULL',
    )


def downgrade():
    op.drop_constraint('user_activity_war_room_id_fkey', 'user_activity', type_='foreignkey')
    op.create_foreign_key(
        'user_activity_war_room_id_fkey',
        'user_activity', 'war_room',
        ['war_room_id'], ['war_room_id'],
    )
