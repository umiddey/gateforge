import helpers_rules
import missing_helpers

from helpers_rules import register
from models import DecoRow


@register
def deco_worker(session):
    session.execute(DecoRow)


if __name__ == "__main__":
    helpers_rules.write_static(None)
    missing_helpers.write()
    deco_worker(None)
