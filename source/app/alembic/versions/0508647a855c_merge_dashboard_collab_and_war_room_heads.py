"""Merge dashboard/collab merge head and war_room_teams head

The upstream sync merge brought in war_room_teams_and_chat_attachments
(f7a3b9c1d02e), based on d5e6f7a8b9c0, on a sibling branch to the
dashboard/collab merge head (b5c6d7e8f9a0), re-forking the alembic
head into two.

Revision ID: 0508647a855c
Revises: b5c6d7e8f9a0, f7a3b9c1d02e
Create Date: 2026-07-13 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = '0508647a855c'
down_revision = ('b5c6d7e8f9a0', 'f7a3b9c1d02e')
branch_labels = None
depends_on = None


def upgrade():
    pass


def downgrade():
    pass
