# Keep Ktor
-keep class io.ktor.** { *; }
-keep class io.netty.** { *; }
-dontwarn io.netty.**

# Keep Kotlin serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class com.homestead.mobile.**$$serializer { *; }
-keepclassmembers class com.homestead.mobile.** { *** Companion; }
-keepclasseswithmembers class com.homestead.mobile.** { kotlinx.serialization.KSerializer serializer(...); }
