cask "simplemd" do
  version "{{VERSION}}"

  on_arm do
    sha256 "{{MAC_ARM64_SHA256}}"
    url "{{MAC_ARM64_URL}}"
  end
  on_intel do
    sha256 "{{MAC_X64_SHA256}}"
    url "{{MAC_X64_URL}}"
  end

  name "SimpleMD"
  desc "Markdown and MDX reader and editor"
  homepage "https://github.com/JonathanRReed/Simple-md"

  depends_on macos: ">= :ventura"
  app "SimpleMD.app"
  binary "#{appdir}/SimpleMD.app/Contents/Resources/native/simplemd"
end
