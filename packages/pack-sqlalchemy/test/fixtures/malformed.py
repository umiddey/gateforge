"""A deliberately malformed Python file (GF-19): must surface as a
PARSE_ERROR finding with a line number, never crash the scan, and
contribute no resources.
"""

class Broken(:  # syntax error on line 6
    __tablename__ = "broken"
    id = Column(Integer, primary_key=True)