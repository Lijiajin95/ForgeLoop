"""受控热升级拒绝侧：缺批准、身份漂移、产物不符、标签漂移与托管前缀绕行。

每个用例都要求旧版继续运行、current 不变、没有安装/激活副作用；拒绝原因可回查。
"""

import subprocess

from test_supervised_upgrade import (
    NEW_DIGEST,
    OTHER_DIGEST,
    SupervisedUpgradeScene,
    _alive,
)

from forgeloop.adapter.upgrade_control import control_request
from forgeloop.domain.upgrade import PHASE_COMMITTED, PROTOCOL_VERSION


def _scene(**kwargs) -> SupervisedUpgradeScene:
    scene = SupervisedUpgradeScene(**kwargs)
    scene.start()
    return scene


def _assert_old_still_running(scene: SupervisedUpgradeScene, old_pid: int) -> None:
    state = scene.state()
    assert state is not None
    assert state.phase == PHASE_COMMITTED
    assert state.identity.version == "0.0.1"
    assert scene.current_version() == "0.0.1"
    assert _alive(old_pid)
    assert scene.status()["child_pid"] == old_pid


class TestMissingAuthority:
    def test_without_deploy_approval_is_refused(self) -> None:
        scene = _scene(approve=False)
        try:
            old_pid = int(scene.status()["child_pid"])
            response = scene.switch()
            assert response["ok"] is False
            assert "部署批准" in response["message"]
            _assert_old_still_running(scene, old_pid)
        finally:
            scene.cleanup()

    def test_wrong_artifact_digest_is_refused(self) -> None:
        scene = _scene()
        try:
            old_pid = int(scene.status()["child_pid"])
            response = scene.switch(digest=OTHER_DIGEST)
            assert response["ok"] is False
            assert "发布回执不符" in response["message"]
            _assert_old_still_running(scene, old_pid)
        finally:
            scene.cleanup()

    def test_missing_release_receipt_is_refused(self) -> None:
        scene = _scene()
        try:
            old_pid = int(scene.status()["child_pid"])
            response = scene.switch(tag="v0.0.9", digest=OTHER_DIGEST)
            assert response["ok"] is False
            assert "发布回执" in response["message"]
            _assert_old_still_running(scene, old_pid)
        finally:
            scene.cleanup()


class TestIdentityDrift:
    def test_other_project_is_refused(self) -> None:
        scene = _scene()
        try:
            old_pid = int(scene.status()["child_pid"])
            response = scene.switch(project="other")
            assert response["ok"] is False
            assert "绑定不符" in response["message"]
            _assert_old_still_running(scene, old_pid)
        finally:
            scene.cleanup()

    def test_other_prefix_is_refused(self) -> None:
        scene = _scene()
        try:
            old_pid = int(scene.status()["child_pid"])
            response = scene.switch(prefix="/tmp/not-this-prefix")
            assert response["ok"] is False
            assert "绑定不符" in response["message"]
            _assert_old_still_running(scene, old_pid)
        finally:
            scene.cleanup()

    def test_tampered_candidate_manifest_is_refused(self) -> None:
        scene = _scene()
        try:
            old_pid = int(scene.status()["child_pid"])
            manifest = scene.prefix / "releases" / "0.0.2" / "artifact.json"
            manifest.write_text(
                manifest.read_text(encoding="utf-8").replace(NEW_DIGEST, OTHER_DIGEST),
                encoding="utf-8",
            )
            response = scene.switch()
            assert response["ok"] is False
            assert "artifact.json" in response["message"]
            _assert_old_still_running(scene, old_pid)
        finally:
            scene.cleanup()

    def test_same_version_other_artifact_is_refused(self) -> None:
        scene = _scene()
        try:
            first = scene.switch()
            assert first["ok"] is True, first
            new_pid = int(scene.status()["child_pid"])
            state = scene.state()
            assert state is not None
            generation = state.generation
            response = scene.switch(digest=OTHER_DIGEST)
            assert response["ok"] is False
            assert "同版本不同产物" in response["message"]
            state = scene.state()
            assert state is not None and state.phase == PHASE_COMMITTED
            assert state.generation == generation
            assert scene.status()["child_pid"] == new_pid
            assert scene.current_version() == "0.0.2"
        finally:
            scene.cleanup()


class TestReleaseIdentity:
    def test_moved_tag_is_refused(self) -> None:
        scene = _scene()
        try:
            old_pid = int(scene.status()["child_pid"])
            env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(scene.root)}
            (scene.repo / "README.md").write_text("changed\n", encoding="utf-8")
            for args in (
                ("add", "-A"),
                ("-c", "user.name=t", "-c", "user.email=t@e", "commit", "-m", "move"),
            ):
                subprocess.run(
                    ["git", "-C", str(scene.repo), *args],
                    check=True,
                    capture_output=True,
                    env=env,
                )
            new_commit = subprocess.run(
                ["git", "-C", str(scene.repo), "rev-parse", "HEAD"],
                check=True,
                capture_output=True,
                text=True,
                env=env,
            ).stdout.strip()
            subprocess.run(
                ["git", "-C", str(scene.repo), "tag", "-f", "v0.0.2", new_commit],
                check=True,
                capture_output=True,
                env=env,
            )
            response = scene.switch()
            assert response["ok"] is False
            assert "标签提交" in response["message"]
            _assert_old_still_running(scene, old_pid)
        finally:
            scene.cleanup()


class TestManagedPrefixBypass:
    def test_rollback_is_refused_on_managed_prefix(self, capsys) -> None:
        from forgeloop.cli.main import main

        scene = _scene()
        try:
            code = main(
                [
                    "rollback",
                    "--to",
                    "0.0.1",
                    "--prefix",
                    str(scene.prefix),
                ]
            )
            captured = capsys.readouterr()
            assert code == 1
            assert "已由固定启动器托管" in captured.out + captured.err
            assert scene.current_version() == "0.0.1"
        finally:
            scene.cleanup()

    def test_bootstrap_is_refused_after_first_integration(self, capsys) -> None:
        from forgeloop.cli.main import main

        scene = _scene()
        try:
            code = main(
                [
                    "deploy",
                    "--tag",
                    "v0.0.2",
                    "--artifact",
                    str(scene.root / "nope.whl"),
                    "--bootstrap",
                    "--prefix",
                    str(scene.prefix),
                ]
            )
            captured = capsys.readouterr()
            assert code == 1
            assert "已由固定启动器托管" in captured.out + captured.err
        finally:
            scene.cleanup()


class TestControlAbuse:
    def test_unknown_operation_has_no_side_effect(self) -> None:
        scene = _scene()
        try:
            before = scene.state()
            response = control_request(
                scene.prefix,
                {"protocol_version": PROTOCOL_VERSION, "operation": "exec"},
            )
            assert response["ok"] is False
            assert response["code"] == "unsupported_operation"
            assert scene.state() == before
        finally:
            scene.cleanup()
