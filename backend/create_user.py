"""One-time CLI to create a user directly in the database — there is no
signup flow (a manufacturing platform's users are provisioned by an admin,
not self-registered), so the very first Super Admin has to be seeded this
way. A Company Admin normally creates operational/company_admin users for
their own project through the real "People & roles" page instead; this
script exists only because the FIRST Super Admin has nobody to be created by.

Usage:
    python -m backend.create_user --email you@company.com --role super_admin
    python -m backend.create_user --email admin@acme.com --role company_admin --project-id <id>
"""

import argparse
import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from backend import auth, db  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--email", required=True)
    parser.add_argument("--role", required=True, choices=list(auth.ROLES))
    parser.add_argument("--project-id", default=None, help="required for company_admin/operational, omit for super_admin")
    parser.add_argument("--name", default=None)
    args = parser.parse_args()

    if args.role != "super_admin" and not args.project_id:
        parser.error(f"--project-id is required for role {args.role!r}")
    if args.role == "super_admin" and args.project_id:
        parser.error("super_admin must not have a --project-id — it's platform-wide by definition")

    db.init_db()

    if db.get_user_by_email(args.email) is not None:
        print(f"A user with email {args.email!r} already exists.", file=sys.stderr)
        sys.exit(1)

    if args.role != "super_admin" and db.get_project(args.project_id) is None:
        print(f"No project with id {args.project_id!r} exists.", file=sys.stderr)
        sys.exit(1)

    password = getpass.getpass("Password: ")
    confirm = getpass.getpass("Confirm password: ")
    if password != confirm:
        print("Passwords did not match.", file=sys.stderr)
        sys.exit(1)
    if len(password) < 8:
        print("Password must be at least 8 characters.", file=sys.stderr)
        sys.exit(1)

    user = db.create_user(args.email, auth.hash_password(password), args.role, args.project_id, args.name)
    print(f"Created {user['role']} user {user['email']!r} (id {user['id']}).")


if __name__ == "__main__":
    main()
