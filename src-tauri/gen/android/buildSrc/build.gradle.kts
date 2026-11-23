plugins {
    `kotlin-dsl`
}

gradlePlugin {
    plugins {
        create("pluginsForCoolKids") {
            id = "rust"
            implementationClass = "RustPlugin"
        }
    }
}

repositories {
    google()
    mavenCentral()
}

dependencies {
    compileOnly(gradleApi())
    // Pinned below AGP's current 9.3.1 template default: AGP 9.x hard-requires
    // SDK Build Tools 36.0.0 (ignores an explicit buildToolsVersion override),
    // which isn't installed and can't be downloaded on this network. 8.13.0 is
    // the lowest AGP release whose `optimization { enable = true }` DSL (used
    // in app/build.gradle.kts) exists, and its default build-tools (35.0.0)
    // matches what's already installed.
    implementation("com.android.tools.build:gradle:8.13.0")
}

