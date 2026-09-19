# SPDX-License-Identifier: Apache-2.0
"""Fixed, offline JDT LS launcher for an immutable single-file probe."""
import os
from pathlib import Path
import shutil
import sys
import tempfile

JAVA_HOME = "/usr/lib/jvm/java-21-openjdk-amd64"

def main():
    if len(sys.argv) != 1:
        raise ValueError("java-probe-arguments-not-allowed")
    launchers = sorted(Path("/opt/jdtls/plugins").glob("org.eclipse.equinox.launcher_*.jar"))
    if len(launchers) != 1:
        raise ValueError("java-probe-launcher-unavailable")
    temporary = Path(tempfile.mkdtemp(prefix="yhwh-jdtls-", dir="/tmp"))
    configuration = temporary / "configuration"
    shutil.copytree("/opt/jdtls/config_linux", configuration)
    command = [JAVA_HOME + "/bin/java", "-Xms64m", "-Xmx512m",
               "-XX:ActiveProcessorCount=1", "-XX:+UseSerialGC", "-XX:TieredStopAtLevel=1",
               "-XX:+DisableAttachMechanism", "-XX:-UsePerfData",
               "-Declipse.application=org.eclipse.jdt.ls.core.id1",
               "-Dosgi.bundles.defaultStartLevel=4",
               "-Declipse.product=org.eclipse.jdt.ls.core.product",
               "-Dlog.protocol=false", "-Dlog.level=WARNING",
               "-jar", str(launchers[0]), "-configuration", str(configuration),
               "-data", str(temporary / "data")]
    os.execve(command[0], command, {"HOME": "/tmp", "JAVA_HOME": JAVA_HOME,
        "PATH": JAVA_HOME + "/bin:/usr/bin:/bin", "LD_LIBRARY_PATH": JAVA_HOME + "/lib"})

if __name__ == "__main__":
    main()
