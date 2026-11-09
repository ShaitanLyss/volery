pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // The rustls platform verifier ships its Android half (a Java
        // certificate verifier the Rust side calls through JNI) as a prebuilt
        // AAR here. Without it the app gets
        // ClassNotFoundException: org.rustls.platformverifier.CertificateVerifier
        // on the first dial. The version is pinned in app/build.gradle.kts.
        maven {
            url = uri("https://github.com/rustls/rustls-platform-verifier/raw/maven-archive/android-release-support/maven/")
        }
    }
}

rootProject.name = "volery-phone"
include(":app")
