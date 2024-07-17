import 'reflect-metadata';
import { splitMessage } from '$lib/utils/commitMessage';
import { hashCode } from '$lib/utils/string';
import { isDefined, notNull } from '$lib/utils/typeguards';
import { ipv4Regex } from '$lib/utils/url';
import { Expose, Type, Transform, type TransformFnParams } from 'class-transformer';
import GitUrlParse from 'git-url-parse';

export type ChangeType =
	/// Entry does not exist in old version
	| 'added'
	/// Entry does not exist in new version
	| 'deleted'
	/// Entry content changed between old and new
	| 'modified';

export class Hunk {
	id!: string;
	diff!: string;
	@Transform((obj) => {
		return new Date(obj.value);
	})
	modifiedAt!: Date;
	filePath!: string;
	hash?: string;
	locked!: boolean;
	@Type(() => HunkLock)
	lockedTo!: HunkLock[];
	changeType!: ChangeType;
	new_start!: number;
	new_lines!: number;
}

export class HunkLock {
	branchId!: string;
	commitId!: string;
}

export type AnyFile = LocalFile | RemoteFile;

export class LocalFile {
	id!: string;
	path!: string;
	@Type(() => Hunk)
	hunks!: Hunk[];
	expanded?: boolean;
	@Transform((obj) => new Date(obj.value))
	modifiedAt!: Date;
	// This indicates if a file has merge conflict markers generated and not yet resolved.
	// This is true for files after a branch which does not apply cleanly (Branch.isMergeable === false) is applied.
	// (therefore this field is applicable only for the workspace, i.e. active === true)
	conflicted!: boolean;
	content!: string;
	binary!: boolean;
	large!: boolean;

	get filename(): string {
		const parts = this.path.split('/');
		return parts[parts.length - 1];
	}

	get justpath() {
		return this.path.split('/').slice(0, -1).join('/');
	}

	get hunkIds() {
		return this.hunks.map((h) => h.id);
	}

	get locked(): boolean {
		return this.hunks
			? this.hunks.map((hunk) => hunk.locked).reduce((a, b) => !!(a || b), false)
			: false;
	}

	get lockedIds(): HunkLock[] {
		return this.hunks
			.flatMap((hunk) => hunk.lockedTo)
			.filter(notNull)
			.filter(isDefined);
	}
}

export class SkippedFile {
	oldPath!: string | undefined;
	newPath!: string | undefined;
	binary!: boolean;
	oldSizeBytes!: number;
	newSizeBytes!: number;
}

export class VirtualBranches {
	@Type(() => Branch)
	branches!: Branch[];
	@Type(() => SkippedFile)
	skippedFiles!: SkippedFile[];
}

export class Branch {
	id!: string;
	name!: string;
	notes!: string;
	// Active means the branch has been applied to the workspace
	active!: boolean;
	@Type(() => LocalFile)
	files!: LocalFile[];
	@Type(() => Commit)
	commits!: Commit[];
	requiresForce!: boolean;
	description!: string;
	head!: string;
	order!: number;
	@Type(() => RemoteBranch)
	upstream?: RemoteBranch;
	upstreamData?: RemoteBranchData;
	upstreamName?: string;
	conflicted!: boolean;
	// TODO: to be removed from the API
	baseCurrent!: boolean;
	ownership!: string;
	// This should actually be named "canBeCleanlyApplied" - if it's false, applying this branch will generate conflict markers,
	// but it's totatlly okay for a user to apply it.
	// If the branch has been already applied, then it was either performed cleanly or we generated conflict markers in the diffs.
	// (therefore this field is applicable for stashed/unapplied or remote branches, i.e. active === false)
	isMergeable!: Promise<boolean>;
	@Transform((obj) => new Date(obj.value))
	updatedAt!: Date;
	// Indicates that branch is default target for new changes
	selectedForChanges!: boolean;
	/// The merge base between the target branch and the virtual branch
	mergeBase!: string;
	/// The fork point between the target branch and the virtual branch
	forkPoint!: string;
	allowRebasing!: boolean;

	get localCommits() {
		return this.commits.filter((c) => c.status === 'local');
	}

	get remoteCommits() {
		return this.commits.filter((c) => c.status === 'localAndRemote');
	}

	get integratedCommits() {
		return this.commits.filter((c) => c.status === 'integrated');
	}

	get displayName() {
		if (this.upstream?.displayName) return this.upstream?.displayName;

		return this.upstreamName || this.name;
	}
}

// Used for dependency injection
export const BRANCH = Symbol('branch');
export type ComponentStyleKind = 'solid' | 'soft';
export type ComponentColor =
	| 'neutral'
	| 'ghost'
	| 'pop'
	| 'success'
	| 'error'
	| 'warning'
	| 'purple';
export type CommitStatus = 'local' | 'localAndRemote' | 'integrated' | 'remote';

export class Commit {
	id!: string;
	author!: Author;
	description!: string;
	@Transform((obj) => new Date(obj.value))
	createdAt!: Date;
	isRemote!: boolean;
	isIntegrated!: boolean;
	@Type(() => LocalFile)
	files!: LocalFile[];
	parentIds!: string[];
	branchId!: string;
	changeId!: string;
	isSigned!: boolean;
	relatedTo?: RemoteCommit;

	prev?: Commit;
	next?: Commit;

	get isLocal() {
		return !this.isRemote && !this.isIntegrated;
	}

	get status(): CommitStatus {
		if (this.isIntegrated) return 'integrated';
		if (this.isRemote && (!this.relatedTo || this.id === this.relatedTo.id))
			return 'localAndRemote';
		return 'local';
	}

	get descriptionTitle(): string | undefined {
		return splitMessage(this.description).title || undefined;
	}

	get descriptionBody(): string | undefined {
		return splitMessage(this.description).description || undefined;
	}

	isParentOf(possibleChild: Commit) {
		return possibleChild.parentIds.includes(this.id);
	}

	isMergeCommit() {
		return this.parentIds.length > 1;
	}
}

export function isLocalCommit(obj: any): obj is Commit {
	return obj instanceof Commit;
}

export class RemoteCommit {
	id!: string;
	author!: Author;
	description!: string;
	@Transform((obj) => new Date(obj.value * 1000))
	createdAt!: Date;
	changeId!: string;
	isSigned!: boolean;
	parentIds!: string[];

	prev?: RemoteCommit;
	next?: RemoteCommit;
	relatedTo?: Commit;

	get isLocal() {
		return false;
	}

	get descriptionTitle(): string | undefined {
		return splitMessage(this.description).title || undefined;
	}

	get descriptionBody(): string | undefined {
		return splitMessage(this.description).description || undefined;
	}

	get status(): CommitStatus {
		return 'remote';
	}

	isMergeCommit() {
		return this.parentIds.length > 1;
	}
}

export function isRemoteCommit(obj: any): obj is RemoteCommit {
	return obj instanceof RemoteCommit;
}

export type AnyCommit = Commit | RemoteCommit;

export function commitCompare(left: AnyCommit, right: AnyCommit): boolean {
	if (left.id === right.id) return true;
	if (left.changeId && right.changeId && left.changeId === right.changeId) return true;
	return false;
}

export class RemoteHunk {
	diff!: string;
	hash?: string;
	new_start!: number;
	new_lines!: number;

	get id(): string {
		return hashCode(this.diff);
	}

	get locked() {
		return false;
	}
}

export class RemoteFile {
	path!: string;
	@Type(() => RemoteHunk)
	hunks!: RemoteHunk[];
	binary!: boolean;

	get id(): string {
		return this.path;
	}

	get filename(): string {
		return this.path.replace(/^.*[\\/]/, '');
	}

	get justpath() {
		return this.path.split('/').slice(0, -1).join('/');
	}

	get large() {
		return false;
	}

	get conflicted() {
		return false;
	}

	get hunkIds() {
		return this.hunks.map((h) => h.id);
	}

	get lockedIds(): HunkLock[] {
		return [];
	}

	get locked(): boolean {
		return false;
	}
}

export interface Author {
	email?: string;
	name?: string;
	gravatarUrl?: URL;
	isBot?: boolean;
}

export class RemoteBranch {
	sha!: string;
	name!: string;
	upstream?: string;
	lastCommitTimestampMs?: number | undefined;
	lastCommitAuthor?: string | undefined;

	get displayName(): string {
		return this.name.replace('refs/remotes/', '').replace('refs/heads/', '');
	}
}

export class RemoteBranchData {
	sha!: string;
	name!: string;
	upstream?: string;
	behind!: number;
	@Type(() => RemoteCommit)
	commits!: RemoteCommit[];
	isMergeable!: boolean | undefined;
	forkPoint?: string | undefined;

	get ahead(): number {
		return this.commits.length;
	}

	get lastCommitTs(): Date | undefined {
		return this.commits[0]?.createdAt;
	}

	get firstCommitAt(): Date {
		return this.commits[this.commits.length - 1].createdAt;
	}

	get authors(): Author[] {
		const allAuthors = this.commits.map((commit) => commit.author);
		const uniqueAuthors = allAuthors.filter(
			(author, index) => allAuthors.findIndex((a) => a.email === author.email) === index
		);
		return uniqueAuthors;
	}

	get displayName(): string {
		return this.name.replace('refs/remotes/', '').replace('origin/', '').replace('refs/heads/', '');
	}
}

export enum Forge {
	Unknown,
	GitHub,
	GitLab,
	Bitbucket,
	AzureDevOps
}

export type ForgeType = keyof typeof Forge;

export class BaseBranch {
	branchName!: string;
	remoteName!: string;
	pushRemoteName!: string;
	baseSha!: string;
	currentSha!: string;
	behind!: number;
	@Type(() => RemoteCommit)
	upstreamCommits!: RemoteCommit[];
	@Type(() => RemoteCommit)
	recentCommits!: RemoteCommit[];
	lastFetchedMs?: number;
	forgeType: ForgeType | undefined;
	remoteUrl!: string;
	repoBaseUrl: string | undefined;
	@Expose({ name: 'pushRemoteUrl' })
	@Transform(({ value }: TransformFnParams) => (value ? GitUrlParse(value) : undefined))
	gitPushRemote!: GitUrlParse.GitUrl | undefined;
	commitBaseUrl: string | undefined;
	actualPushRemoteName: string | undefined;
	private generateCommitUrl: ((commitId: string) => string) | undefined;
	private generateBranchUrl: ((baseBranchName: string, branchName: string) => string) | undefined;

	// TODO: Move most if not all of this to Rust to send over finalized properties from get_base_branch_data
	// Make as many of the one-time business rules run once
	afterTransform(): void {
		const gitRemote = GitUrlParse(this.remoteUrl);
		const remoteUrlProtocol = ipv4Regex.test(gitRemote.resource) ? 'http' : 'https';
		this.repoBaseUrl = `${remoteUrlProtocol}://${gitRemote.resource}/${gitRemote.owner}/${gitRemote.name}`;
		this.forgeType = this.getForgeType(gitRemote.resource);

		this.actualPushRemoteName = this.pushRemoteName || this.remoteName;

		if (this.gitPushRemote) {
			const { organization, owner, name, protocol } = this.gitPushRemote;
			let { resource } = this.gitPushRemote;
			const webProtocol = ipv4Regex.test(resource) ? 'http' : 'https';

			if (protocol === 'ssh' && resource.startsWith('ssh.')) {
				resource = resource.slice(4);
			}

			if (this.forgeType === 'AzureDevOps') {
				this.commitBaseUrl = `${webProtocol}://${resource}/${organization}/${owner}/_git/${name}`;
			} else {
				this.commitBaseUrl = `${webProtocol}://${resource}/${owner}/${name}`;
			}

			// Different Git providers use different paths for the commit url:
			switch (this.forgeType) {
				case 'Bitbucket':
					this.generateCommitUrl = (commitId) => `${this.commitBaseUrl}/commits/${commitId}`;
					break;
				case 'GitLab':
					this.generateCommitUrl = (commitId) => `${this.commitBaseUrl}/-/commit/${commitId}`;
					break;
				case 'AzureDevOps':
				case 'GitHub':
				case 'Unknown':
				default:
					this.generateCommitUrl = (commitId) => `${this.commitBaseUrl}/commit/${commitId}`;
					break;
			}
		}

		if (this.gitPushRemote) {
			if (this.pushRemoteName) {
				if (this.forgeType === 'GitHub') {
					// master...schacon:docs:Virtual-branch
					const pushUsername = this.gitPushRemote.user;
					const pushRepoName = this.gitPushRemote.name;
					this.generateBranchUrl = (baseBranchName, branchName) =>
						`${this.repoBaseUrl}/compare/${baseBranchName}...${pushUsername}:${pushRepoName}:${branchName}`;
				}
			}

			if (!this.generateBranchUrl) {
				switch (this.forgeType) {
					case 'Bitbucket':
						this.generateBranchUrl = (baseBranchName, branchName) =>
							`${this.repoBaseUrl}/branch/${branchName}?dest=${baseBranchName}`;
						break;
					case 'AzureDevOps':
						this.generateBranchUrl = (baseBranchName, branchName) =>
							`${this.commitBaseUrl}/branchCompare?baseVersion=GB${baseBranchName}&targetVersion=GB${branchName}`;
						break;
					// The following branch path is good for at least Gitlab and Github:
					case 'GitHub':
					case 'GitLab':
					case 'Unknown':
					default:
						this.generateBranchUrl = (baseBranchName, branchName) =>
							`${this.repoBaseUrl}/compare/${baseBranchName}...${branchName}`;
						break;
				}
			}
		}
	}

	private getForgeType(repoBaseUrl: string): ForgeType {
		switch (true) {
			case repoBaseUrl.includes('github.com'):
				return 'GitHub';
			case repoBaseUrl.includes('gitlab.com'):
				return 'GitLab';
			case repoBaseUrl.includes('bitbucket.org'):
				return 'Bitbucket';
			case repoBaseUrl.includes('dev.azure.com'):
				return 'AzureDevOps';
			default:
				return 'Unknown';
		}
	}

	get lastFetched(): Date | undefined {
		return this.lastFetchedMs ? new Date(this.lastFetchedMs) : undefined;
	}

	commitUrl(commitId: string): string | undefined {
		return this.generateCommitUrl ? this.generateCommitUrl(commitId) : undefined;
	}

	get shortName() {
		return this.branchName.split('/').slice(-1)[0];
	}

	branchUrl(upstreamBranchName: string | undefined): string | undefined {
		if (!upstreamBranchName || !this.gitPushRemote || !this.generateBranchUrl) return undefined;
		// parameter and variable property, always calculate unless future memoization
		const baseBranchName = this.branchName.split('/')[1];
		const branchName = upstreamBranchName.split('/').slice(3).join('/');

		return this.generateBranchUrl(baseBranchName, branchName);
	}
}
