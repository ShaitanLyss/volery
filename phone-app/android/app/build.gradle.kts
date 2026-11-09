import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The wall key phrase is a secret and lives in `local.properties` (gitignored),
// not here — a lab key is still a key, and the committed project must not carry
// one. `sdk.dir` in the same file is how Android Studio normally points at the
// SDK; the phone fields ride along beside it.
val local = Properties()
val localFile = rootProject.file("local.properties")
if (localFile.exists()) localFile.inputStream().use { local.load(it) }

fun quoted(v: String) = "\"" + v.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

android {
    namespace = "com.volery.phone"
    compileSdk = 35
    // 35.0.0 is what this machine already has; AGP 8.7 otherwise wants 34.0.0,
    // whose license is not accepted and whose SDK dir is read-only.
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "com.volery.phone"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        buildConfigField("String", "PHONE_KEY", quoted(local.getProperty("phone.key", "")))
        buildConfigField("String", "PHONE_HOST", quoted(local.getProperty("phone.host", "lab-m2.queerisfreedom")))
        buildConfigField("String", "PHONE_NAME", quoted(local.getProperty("phone.name", "phone")))
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // The platform verifier's Android half — a Java certificate verifier the
    // Rust side (`init_with_env`) calls through JNI to check the relay's TLS
    // chain. The version must track the `rustls-platform-verifier-android`
    // crate in `../ffi/Cargo.lock` (0.2.0 today); the crate README's "Gradle
    // setup" shows the dynamic Cargo-synced variant if this ever drifts.
    implementation("org.rustls:rustls-platform-verifier:0.2.0")
}
