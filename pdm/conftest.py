# Empty on purpose: its mere presence at the pdm/ root makes pytest insert
# pdm/ onto sys.path during collection, so tests/test_rules.py's
# `from app import rules` resolves regardless of the invocation cwd.
