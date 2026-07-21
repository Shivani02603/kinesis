"""Real authentication: bcrypt password hashing, opaque bearer-token sessions
stored in SQLite (backend/db.py), and FastAPI dependencies that gate every
project-scoped endpoint by the caller's actual role and project_id.

Three roles, matching the tiers already designed and agreed:
- super_admin: platform-wide, project_id is NULL, can act on any project.
- company_admin, operational: each tied to exactly one project_id — the same
  multi-tenant boundary every other table already scopes by. Either role may
  only touch ITS OWN project_id; anything else is a 403, not a silent no-op.
"""

import bcrypt
from fastapi import Depends, Header, HTTPException

from . import db

ROLES = ("super_admin", "company_admin", "operational")


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        # A malformed/foreign hash is a real verification failure, not a crash.
        return False


def _extract_token(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated — missing bearer token")
    return authorization.split(" ", 1)[1].strip()


def current_user(authorization: str | None = Header(None)) -> dict:
    """FastAPI dependency: the logged-in user for this request, or a 401."""
    token = _extract_token(authorization)
    user = db.get_session_user(token)
    if user is None:
        raise HTTPException(status_code=401, detail="Session is invalid or has expired — please log in again")
    return user


def require_super_admin(user: dict = Depends(current_user)) -> dict:
    """Use as a dependency: raises 403 unless the caller is a super_admin."""
    if user["role"] != "super_admin":
        raise HTTPException(status_code=403, detail="Only a Super Admin can do this")
    return user


def check_project_access(user: dict, project_id: str) -> None:
    """Raises 403 unless this user may act on this specific project — a
    super_admin may touch any project, everyone else only their own."""
    if user["role"] == "super_admin":
        return
    if user.get("project_id") != project_id:
        raise HTTPException(status_code=403, detail="You don't have access to this company's data")
