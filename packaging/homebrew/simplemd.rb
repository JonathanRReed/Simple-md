cask "simplemd" do
  version "{{VERSION}}"

  sha256 "{{MAC_ARM64_SHA256}}"
  url "{{MAC_ARM64_URL}}"

  name "SimpleMD"
  desc "Markdown and MDX reader and editor"
  homepage "https://github.com/JonathanRReed/Simple-md"

  depends_on arch: :arm64
  depends_on macos: ">= :ventura"
  app "SimpleMD.app"
  binary "#{appdir}/SimpleMD.app/Contents/Resources/native/simplemd"
end
