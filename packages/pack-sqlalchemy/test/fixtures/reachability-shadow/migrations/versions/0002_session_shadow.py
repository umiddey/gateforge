from session_module_shadow import module_session
from session_shadow import (
    local_session,
    param_session,
    param_sessionmaker,
    param_table,
    real_session,
    real_sessionmaker,
    real_table,
)

revision = "0002_session_shadow"


def upgrade():
    param_session(None)
    local_session()
    param_sessionmaker(None)
    param_table(None)
    real_session()
    real_sessionmaker()
    real_table()
    module_session()
