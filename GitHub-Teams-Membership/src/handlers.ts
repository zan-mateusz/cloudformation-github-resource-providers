import {
    Action,
    BaseResource,
    exceptions,
    handlerEvent,
    LoggerProxy,
    OperationStatus,
    Optional,
    ProgressEvent,
    ResourceHandlerRequest,
    SessionProxy,
} from '@amazon-web-services-cloudformation/cloudformation-cli-typescript-lib';
import {ResourceModel} from './models';
import {Endpoints, OctokitResponse, RequestError} from "@octokit/types";
import {Octokit} from "@octokit/rest";
import {handleError} from "../../GitHub-Common/src/util";

import {version} from '../package.json';

type GetMembershipEndpoint = 'GET /orgs/{org}/teams/{team_slug}/memberships/{username}';
type AddOrUpdateMembershipEndpoint = 'PUT /orgs/{org}/teams/{team_slug}/memberships/{username}';

type GetMembershipResponseData = Endpoints[GetMembershipEndpoint]['response']['data'];
type AddOrUpdateMembershipResponseData = Endpoints[AddOrUpdateMembershipEndpoint]['response']['data'];

type MembershipData =
    GetMembershipResponseData &
    AddOrUpdateMembershipResponseData;


interface CallbackContext extends Record<string, any> {
}

class Resource extends BaseResource<ResourceModel> {

    private userAgent = `AWS CloudFormation (+https://aws.amazon.com/cloudformation/) CloudFormation resource ${this.typeName}/${version}`;

    private static setModelFromApiResponse(baseModel: ResourceModel, data: MembershipData): ResourceModel {
        baseModel.role = data.role;
        baseModel.state = data.state;
        return baseModel;
    }

    private static getErrorMessage(requestError: RequestError, errorResponse: Error) {
        return requestError.errors?.map(e => e.message).join('\n') || errorResponse.message;
    }

    /**
     * CloudFormation invokes this handler when the resource is initially created
     * during stack create operations.
     *
     * @param session Current AWS session passed through from caller
     * @param request The request object for the provisioning request passed to the implementor
     * @param callbackContext Custom context object to allow the passing through of additional
     * state or metadata between subsequent retries
     * @param logger Logger to proxy requests to default publishers
     */
    @handlerEvent(Action.Create)
    public async create(
        session: Optional<SessionProxy>,
        request: ResourceHandlerRequest<ResourceModel>,
        callbackContext: CallbackContext,
        logger: LoggerProxy,
    ): Promise<ProgressEvent<ResourceModel, CallbackContext>> {
        const model = new ResourceModel(request.desiredResourceState);
        if (!! await this.assertMembershipExist(model, request)) {
            throw new exceptions.AlreadyExists(this.typeName, request.logicalResourceIdentifier);
        }
        const response = await this.addOrUpdateMembership(model, request);
        return ProgressEvent.success<ProgressEvent<ResourceModel, CallbackContext>>(Resource.setModelFromApiResponse(model, response.data));
    }

    /**
     * CloudFormation invokes this handler when the resource is updated
     * as part of a stack update operation.
     *
     * @param session Current AWS session passed through from caller
     * @param request The request object for the provisioning request passed to the implementor
     * @param callbackContext Custom context object to allow the passing through of additional
     * state or metadata between subsequent retries
     * @param logger Logger to proxy requests to default publishers
     */
    @handlerEvent(Action.Update)
    public async update(
        session: Optional<SessionProxy>,
        request: ResourceHandlerRequest<ResourceModel>,
        callbackContext: CallbackContext,
        logger: LoggerProxy
    ): Promise<ProgressEvent<ResourceModel, CallbackContext>> {
        const model = new ResourceModel(request.desiredResourceState);
        if (!await this.assertMembershipExist(model, request)) {
            throw new exceptions.NotFound(this.typeName, request.logicalResourceIdentifier);
        }
        const response = await this.addOrUpdateMembership(model, request);
        return ProgressEvent.success<ProgressEvent<ResourceModel, CallbackContext>>(Resource.setModelFromApiResponse(model, response.data));
    }

    /**
     * CloudFormation invokes this handler when the resource is deleted, either when
     * the resource is deleted from the stack as part of a stack update operation,
     * or the stack itself is deleted.
     *
     * @param session Current AWS session passed through from caller
     * @param request The request object for the provisioning request passed to the implementor
     * @param callbackContext Custom context object to allow the passing through of additional
     * state or metadata between subsequent retries
     * @param logger Logger to proxy requests to default publishers
     */
    @handlerEvent(Action.Delete)
    public async delete(
        session: Optional<SessionProxy>,
        request: ResourceHandlerRequest<ResourceModel>,
        callbackContext: CallbackContext,
        logger: LoggerProxy
    ): Promise<ProgressEvent<ResourceModel, CallbackContext>> {
        const model = new ResourceModel(request.desiredResourceState);

        const octokit = new Octokit({
            auth: model.gitHubAccess,
            userAgent: this.userAgent
        });
        if (!await this.assertMembershipExist(model, request)) {
            throw new exceptions.NotFound(this.typeName, request.logicalResourceIdentifier);
        }
        try {
            await octokit.request('DELETE /orgs/{org}/teams/{team_slug}/memberships/{username}', {
                org: model.org,
                team_slug: model.teamSlug,
                username: model.username
            });
            return ProgressEvent.success<ProgressEvent<ResourceModel, CallbackContext>>();
        } catch (e) {
            handleError(e, request, this.typeName);
        }
    }

    /**
     * CloudFormation invokes this handler as part of a stack update operation when
     * detailed information about the resource's current state is required.
     *
     * @param session Current AWS session passed through from caller
     * @param request The request object for the provisioning request passed to the implementor
     * @param callbackContext Custom context object to allow the passing through of additional
     * state or metadata between subsequent retries
     * @param logger Logger to proxy requests to default publishers
     */
    @handlerEvent(Action.Read)
    public async read(
        session: Optional<SessionProxy>,
        request: ResourceHandlerRequest<ResourceModel>,
        callbackContext: CallbackContext,
        logger: LoggerProxy
    ): Promise<ProgressEvent<ResourceModel, CallbackContext>> {
        const model = new ResourceModel(request.desiredResourceState);
        const response = await this.getMembership(model, request);
        return ProgressEvent.success<ProgressEvent<ResourceModel, CallbackContext>>(Resource.setModelFromApiResponse(model, response.data));
    }

    /**
     * CloudFormation invokes this handler when summary information about multiple
     * resources of this resource provider is required.
     *
     * @param session Current AWS session passed through from caller
     * @param request The request object for the provisioning request passed to the implementor
     * @param callbackContext Custom context object to allow the passing through of additional
     * state or metadata between subsequent retries
     * @param logger Logger to proxy requests to default publishers
     */
    @handlerEvent(Action.List)
    public async list(
        session: Optional<SessionProxy>,
        request: ResourceHandlerRequest<ResourceModel>,
        callbackContext: CallbackContext,
        logger: LoggerProxy
    ): Promise<ProgressEvent<ResourceModel, CallbackContext>> {
        const model = new ResourceModel(request.desiredResourceState);

        const octokit = new Octokit({
            auth: model.gitHubAccess,
            userAgent: this.userAgent
        });

        try {
            const orgAndTeam = {
                org: model.org,
                team_slug: model.teamSlug,
            };
            const currentMembers = await octokit.paginate(octokit.teams.listMembersInOrg, orgAndTeam,response => response.data.map(membershipItem => {
                const resourceModel = new ResourceModel();
                resourceModel.username = membershipItem.login;
                resourceModel.org = model.org;
                resourceModel.teamSlug = model.teamSlug;
                resourceModel.state = "active"
                return resourceModel;
            }));

            const pendingInvites = await octokit.paginate(octokit.teams.listPendingInvitationsInOrg, orgAndTeam,response => response.data.map(membershipItem => {
                const resourceModel = new ResourceModel();
                resourceModel.username = membershipItem.login;
                resourceModel.org = model.org;
                resourceModel.teamSlug = model.teamSlug;
                resourceModel.state = "pending";
                return resourceModel;
            }));
            return ProgressEvent.builder<ProgressEvent<ResourceModel, CallbackContext>>()
                .status(OperationStatus.Success)
                .resourceModels(currentMembers.concat(pendingInvites)).build();
        } catch (e) {
            handleError(e, request, this.typeName);
        }
    }

    private async assertMembershipExist(model: ResourceModel, request: ResourceHandlerRequest<ResourceModel>) {
        try {
            return await this.getMembership(model, request);
        } catch (e) {
            return false;
        }
    }

    private async getMembership(model: ResourceModel, request: ResourceHandlerRequest<ResourceModel>): Promise<OctokitResponse<GetMembershipResponseData>> {
        const octokit = new Octokit({
            auth: model.gitHubAccess,
            userAgent: this.userAgent
        });

        try {
            return await octokit.request('GET /orgs/{org}/teams/{team_slug}/memberships/{username}', {
                org: model.org,
                team_slug: model.teamSlug,
                username: model.username,
            });
        } catch (e) {
            handleError(e, request, this.typeName);
        }
    }

    private async addOrUpdateMembership(model: ResourceModel, request: ResourceHandlerRequest<ResourceModel>): Promise<OctokitResponse<AddOrUpdateMembershipResponseData>> {
        const octokit = new Octokit({
            auth: model.gitHubAccess,
            userAgent: this.userAgent
        });

        try {
            return await octokit.request('PUT /orgs/{org}/teams/{team_slug}/memberships/{username}', {
                org: model.org,
                team_slug: model.teamSlug,
                username: model.username,
                role: model.role as "member" | "maintainer"
            });
        } catch (e) {
            handleError(e, request, this.typeName);
        }
    }
}

export const resource = new Resource(ResourceModel.TYPE_NAME, ResourceModel);

// Entrypoint for production usage after registered in CloudFormation
export const entrypoint = resource.entrypoint;

// Entrypoint used for local testing
export const testEntrypoint = resource.testEntrypoint;