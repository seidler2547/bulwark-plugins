"""Seed the test Seafile: users alice and bob, libraries with files, a share link.

    python seed/seed_seafile.py

Also adds to seahub_settings.py what the Seafile plugin signs in with (the
browser sign-in for clients, CLIENT_SSO_VIA_LOCAL_BROWSER) and what lets the
seeded users sign in with their passwords (FORCE_PASSWORD_CHANGE = False),
and restarts Seafile's web part when that changed something.

Idempotent: existing users, libraries, files and links are kept.
"""
import os
import sys
import uuid
from urllib.parse import quote, urlencode, urlsplit, urlunsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import docker_exec, http, minimal_pdf, minimal_png, wait_for, write_secret  # noqa: E402

CONTAINER = 'bpt-seafile'
BASE = os.environ.get('SEAFILE_URL', 'http://localhost:18090')
ADMIN = ('admin@example.org', os.environ.get('SEAFILE_ADMIN_PASSWORD', 'admin-pass-123'))
ALICE = ('alice@example.org', os.environ.get('SEAFILE_ALICE_PASSWORD', 'alice-pass-123'), 'Alice Example')
BOB = ('bob@example.org', os.environ.get('SEAFILE_BOB_PASSWORD', 'bob-pass-123'), 'Bob Example')
LARGE_MB = 60
SETTINGS_FILE = '/shared/seafile/conf/seahub_settings.py'
# What the plugin and these seeds need on top of Seafile's defaults.
SETTINGS = {
    # The sign-in the desktop clients use, through the browser: the plugin's way in.
    'CLIENT_SSO_VIA_LOCAL_BROWSER': 'True',
    # Users made by an admin would have to change their password on first login.
    'FORCE_PASSWORD_CHANGE': 'False',
}

# library -> { path in it: content }
LIBRARIES = {
    'Documents': {
        'Welcome.txt': b'Welcome to the Bulwark plugin test Seafile.\n',
        'Report 2026.pdf': minimal_pdf(['Quarterly report 2026', 'Revenue up, costs down.']),
        'Invoices/invoice-2026-10.pdf': minimal_pdf(['Invoice 2026-10', 'Amount due: 120.00 EUR']),
    },
    'Photos': {
        'blue.png': minimal_png(rgb=(37, 99, 235)),
        'orange.png': minimal_png(width=120, height=80, rgb=(234, 88, 12)),
    },
    'Projects': {
        'Bulwark/notes.txt': 'Notizen mit Umlauten: äöü ß\n'.encode('utf-8'),
        'Bulwark/plan.md': b'# Plan\n\n- test the Seafile plugin\n',
    },
    'Large': {},
}
SHARED = ('Documents', '/Report 2026.pdf')
STARRED = [('Documents', '/Welcome.txt'), ('Projects', '/Bulwark')]


def ensure_settings():
    """Add the settings above to seahub_settings.py; restart Seafile's web part when one was missing."""
    current = docker_exec(CONTAINER, 'cat', SETTINGS_FILE).stdout
    missing = [f'{key} = {value}' for key, value in SETTINGS.items() if f'{key} = {value}' not in current]
    if not missing:
        return False
    docker_exec(CONTAINER, 'sh', '-c', f'cat >> {SETTINGS_FILE}', stdin='\n' + '\n'.join(missing) + '\n')
    docker_exec(CONTAINER, '/opt/seafile/seafile-server-latest/seahub.sh', 'restart')
    wait_for('Seafile after its restart', ping, timeout=180, interval=2)
    return True


def on_base(link):
    """A file-server link Seafile handed out, on the address this seed talks to.

    Seafile builds its links from SEAFILE_SERVER_HOSTNAME, which may be a name
    only the compose network knows (bpt-seafile).
    """
    base, url = urlsplit(BASE), urlsplit(link)
    return urlunsplit((base.scheme, base.netloc, url.path, url.query, ''))


def ping():
    return http('GET', f'{BASE}/api2/ping/', timeout=5).status == 200


def login(email, password):
    """A Web API token for a password account, or None."""
    r = http('POST', f'{BASE}/api2/auth-token/', body=urlencode({'username': email, 'password': password}),
             headers={'Content-Type': 'application/x-www-form-urlencoded'})
    return r.json().get('token') if r.status == 200 else None


class Seafile:
    def __init__(self, token):
        self.headers = {'Authorization': f'Token {token}', 'Accept': 'application/json'}

    def call(self, method, path, body=None, form=None, ok=(200, 201)):
        headers = dict(self.headers)
        if form is not None:
            body = urlencode(form)
            headers['Content-Type'] = 'application/x-www-form-urlencoded'
        r = http(method, f'{BASE}{path}', body=body, headers=headers, timeout=300)
        if r.status not in ok:
            sys.exit(f'{method} {path}: {r.status} {r.text[:300]}')
        return r

    def me(self):
        return self.call('GET', '/api2/account/info/').json()

    def library(self, name):
        """The id of the user's own library with this name, made when missing."""
        for repo in self.call('GET', '/api/v2.1/repos/?type=mine').json()['repos']:
            if repo['repo_name'] == name:
                return repo['repo_id'], False
        return self.call('POST', '/api2/repos/', form={'name': name}).json()['repo_id'], True

    def names(self, repo_id, folder):
        r = self.call('GET', f'/api/v2.1/repos/{repo_id}/dir/?p={quote(folder)}', ok=(200, 404))
        return None if r.status == 404 else {d['name'] for d in r.json()['dirent_list']}

    def mkdirs(self, repo_id, folder):
        acc = ''
        for part in [p for p in folder.split('/') if p]:
            parent, acc = acc or '/', f'{acc}/{part}'
            if part not in (self.names(repo_id, parent) or set()):
                self.call('POST', f'/api/v2.1/repos/{repo_id}/dir/?p={quote(acc)}', form={'operation': 'mkdir'})

    def upload(self, repo_id, folder, name, data):
        link = on_base(self.call('GET', f'/api2/repos/{repo_id}/upload-link/?p={quote(folder)}').json())
        mark = f'----seed{uuid.uuid4().hex}'
        body = b''.join([
            f'--{mark}\r\nContent-Disposition: form-data; name="parent_dir"\r\n\r\n{folder}\r\n'.encode('utf-8'),
            f'--{mark}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\n'
            f'Content-Type: application/octet-stream\r\n\r\n'.encode('utf-8'),
            data,
            f'\r\n--{mark}--\r\n'.encode(),
        ])
        r = http('POST', f'{link}{"&" if "?" in link else "?"}ret-json=1', body=body, timeout=600,
                 headers={'Content-Type': f'multipart/form-data; boundary={mark}'})
        if r.status != 200:
            sys.exit(f'upload {folder}/{name}: {r.status} {r.text[:300]}')


def ensure_user(admin, email, password, name):
    token = login(email, password)
    if token:
        return token, False
    admin.call('POST', '/api/v2.1/admin/users/', form={'email': email, 'password': password, 'name': name})
    token = login(email, password)
    if not token:
        sys.exit(f'seafile: {email} was created but cannot sign in')
    return token, True


def main():
    wait_for('Seafile', ping)
    if ensure_settings():
        print('seafile: turned on the browser sign-in for clients and restarted the web part')

    admin_token = login(*ADMIN)
    if not admin_token:
        sys.exit('seafile: the admin cannot sign in; check INIT_SEAFILE_ADMIN_EMAIL / _PASSWORD in docker-compose.yml')
    admin = Seafile(admin_token)

    alice_token, created = ensure_user(admin, *ALICE)
    if created:
        print('seafile: created user alice')
    bob_token, created = ensure_user(admin, *BOB)
    if created:
        print('seafile: created user bob')
    alice, bob = Seafile(alice_token), Seafile(bob_token)

    ids = {}
    for name, files in LIBRARIES.items():
        ids[name], created = alice.library(name)
        if created:
            print('seafile: created library', name)
        for path, data in files.items():
            folder, _, file_name = ('/' + path).rpartition('/')
            folder = folder or '/'
            alice.mkdirs(ids[name], folder)
            if file_name not in alice.names(ids[name], folder):
                alice.upload(ids[name], folder, file_name, data)
                print(f'seafile: uploaded {name}/{path}')

    # A large file for chunked-upload and streamed-download tests.
    large = f'random-{LARGE_MB}mb.bin'
    if large not in alice.names(ids['Large'], '/'):
        alice.upload(ids['Large'], '/', large, os.urandom(LARGE_MB * 1024 * 1024))
        print(f'seafile: uploaded Large/{large}')

    # Favorites, for the plugin's Favorites view.
    starred = {(s['repo_id'], s['path'].rstrip('/') or '/') for s in alice.call('GET', '/api/v2.1/starred-items/').json()['starred_item_list']}
    for name, path in STARRED:
        if (ids[name], path) not in starred:
            alice.call('POST', '/api/v2.1/starred-items/', form={'repo_id': ids[name], 'path': path})

    # A library of bob's that alice may only read.
    team, _ = bob.library('Team')
    if 'handbook.txt' not in bob.names(team, '/'):
        bob.upload(team, '/', 'handbook.txt', b'Shared by Bob, read-only for Alice.\n')
    shared_to = {item['user_info']['name'] for item in
                 bob.call('GET', f'/api2/repos/{team}/dir/shared_items/?p=/&share_type=user').json()}
    alice_id = alice.me()['email']
    if alice_id not in shared_to:
        bob.call('PUT', f'/api2/repos/{team}/dir/shared_items/?p=/',
                 form={'share_type': 'user', 'username': alice_id, 'permission': 'r'})
        print('seafile: shared Team (read-only) with alice')

    links = alice.call('GET', f'/api/v2.1/share-links/?repo_id={ids[SHARED[0]]}&path={quote(SHARED[1])}').json()
    if links:
        share_url = links[0]['link']
    else:
        share_url = alice.call('POST', '/api/v2.1/multi-share-links/', body={
            'repo_id': ids[SHARED[0]], 'path': SHARED[1],
            'permissions': {'can_edit': False, 'can_download': True, 'can_upload': False},
        }).json()['link']
        print('seafile: created share link', share_url)

    path = write_secret('seafile', {
        'url': BASE,
        'admin': {'user': ADMIN[0], 'password': ADMIN[1]},
        'user': ALICE[0],
        'password': ALICE[1],
        'userId': alice_id,
        'token': alice_token,
        'libraries': ids,
        'shareLink': share_url,
        'sharedFile': f'{SHARED[0]}{SHARED[1]}',
        'largeFile': f'Large/{large}',
        'readOnlyLibrary': 'Team',
    })
    print(f'seafile: ok, alice API token {alice_token} (saved to {path})')


if __name__ == '__main__':
    main()
