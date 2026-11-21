from sqlalchemy.orm import Session

from models import ShadowModuleSessionRow

REAL_SESSION = Session


def _stub(engine):
    return None


Session = _stub


def module_session():
    s = Session(None)
    s.add(ShadowModuleSessionRow())
