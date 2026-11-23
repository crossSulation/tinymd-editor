# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# Without this, R8 can strip an enum's synthetic values()/valueOf() methods
# whenever the only caller is reflection (Class.getEnumConstants(), the path
# Gson-based deserialization uses) rather than ordinary code -- it can't
# statically prove the reflective call needs them. Confirmed directly as a
# real, reproducible release-build crash on first launch: a self-test release
# APK built without this rule threw
# `NoSuchMethodException: b2.h0.values []` from inside
# `app.tauri.plugin.PluginManager`'s static initializer (its permission-config
# parsing goes through Gson, which enumerates enum constants reflectively) --
# not a theoretical concern, every release build needs this.
-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}